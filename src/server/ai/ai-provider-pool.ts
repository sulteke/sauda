import "server-only";

import {
  geminiFallbackDailyLimit,
  geminiPrimaryDailyLimit,
  providerCooldownMs,
} from "@/config/limits";
import {
  type AiCategoryProvider,
  AiCategoryProviderError,
  type AiCategoryRequest,
  type AiCategoryResult,
  disabledAiCategoryProvider,
} from "@/lib/ai-category-provider";
import { startOfBusinessDay } from "@/lib/business-day";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

import { DailyAnalysisLimitError } from "./analysis-budget";
import { DEFAULT_GEMINI_MODEL, GeminiCategoryProvider } from "./gemini-category-provider";

/**
 * Provider pool — the ONE place that decides which AI provider runs, and what
 * happens when it fails.
 *
 * Gemini's rate limits apply per Google Cloud PROJECT, so a second API key only
 * adds capacity when it lives in a different project. The pool therefore treats
 * providers as independent projects: each has its own daily budget, its own
 * cooldown, and its own counter. Nothing here pools them into a single number.
 *
 * Failure handling is deliberately asymmetric:
 *   - transient (429 / 503 / 5xx / timeout / network) → this project is unwell,
 *     park it in cooldown and try the NEXT one;
 *   - permanent (400 / 403) → the request or the key is wrong, and the next
 *     project would fail identically, so fail immediately instead of burning a
 *     second project's quota proving it.
 *
 * Budget: each provider is called AT MOST ONCE per boutique, with the
 * provider's own retry disabled (maxAttempts = 1). A→B, never A→B→A. Two
 * bounded calls also keep the whole analysis inside the serverless time limit.
 *
 * Adding a third provider means adding one entry to {@link configuredProviders}.
 */

/** Stable ids, used for per-provider counting and cooldown rows. */
export const PRIMARY_PROVIDER_ID = "primary";
export const FALLBACK_PROVIDER_ID = "fallback";

/** HTTP statuses that mean "this project is unwell" — try the next provider. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** HTTP statuses that mean "this request/key is wrong" — no point failing over. */
const PERMANENT_STATUS = new Set([400, 401, 403, 404]);

export interface PooledProvider {
  /** "primary" / "fallback" — the identity used everywhere else. */
  id: string;
  /** Google Cloud project this key belongs to (quota is per project). */
  projectId: string | null;
  /** Successful analyses per business day allowed on this project. */
  dailyLimit: number;
  provider: AiCategoryProvider;
}

export interface ProviderUsage {
  id: string;
  projectId: string | null;
  used: number;
  limit: number;
  /** Null when healthy; otherwise the moment it becomes usable again. */
  cooldownUntil: Date | null;
  available: boolean;
}

/**
 * Raised when no provider can run: every one is out of daily budget or cooling
 * down. It extends {@link DailyAnalysisLimitError} so the existing handling —
 * the queue's "stop, resume tomorrow" signal and the manual route's 429 — keeps
 * working unchanged. The per-provider breakdown lives in the message and in
 * `usage`; the summed numbers are reporting only, never a gate.
 */
export class NoProviderAvailableError extends DailyAnalysisLimitError {
  readonly usage: ProviderUsage[];

  constructor(usage: ProviderUsage[]) {
    const used = usage.reduce((sum, u) => sum + u.used, 0);
    const limit = usage.reduce((sum, u) => sum + u.limit, 0);
    super(used, limit);
    this.name = "NoProviderAvailableError";
    this.usage = usage;
    const detail = usage
      .map((u) => `${u.id} ${u.used}/${u.limit}${u.cooldownUntil ? " (cooling down)" : ""}`)
      .join(", ");
    this.message = `No AI provider available right now — ${detail}.`;
  }
}

/**
 * Builds the ordered provider list from the environment.
 *
 * `GEMINI_API_KEY` still works as the primary, so an environment that predates
 * the fallback keeps running unchanged with a single provider.
 */
export function configuredProviders(options: { throwOnFailure?: boolean } = {}): PooledProvider[] {
  const primaryKey = process.env.GEMINI_PRIMARY_API_KEY || process.env.GEMINI_API_KEY;
  const fallbackKey = process.env.GEMINI_FALLBACK_API_KEY;
  const primaryProject = process.env.GEMINI_PRIMARY_PROJECT_ID || null;
  const fallbackProject = process.env.GEMINI_FALLBACK_PROJECT_ID || null;

  const providers: PooledProvider[] = [];
  // maxAttempts: 1 — the pool IS the retry layer now. Leaving the provider's own
  // retry on would spend the whole time budget on a project we are about to
  // abandon, and would delay the fallback that is standing right there.
  const shared = { throwOnFailure: options.throwOnFailure, maxAttempts: 1 };

  if (primaryKey) {
    providers.push({
      id: PRIMARY_PROVIDER_ID,
      projectId: primaryProject,
      dailyLimit: geminiPrimaryDailyLimit(),
      provider: new GeminiCategoryProvider(primaryKey, shared),
    });
  }

  if (fallbackKey) {
    if (primaryKey && fallbackKey === primaryKey) {
      // The same key is the same project — it adds no quota at all.
      logger.warn("ai.pool.duplicate_key", {
        reason: "GEMINI_FALLBACK_API_KEY is identical to the primary key; fallback disabled.",
      });
    } else if (primaryProject && fallbackProject && primaryProject === fallbackProject) {
      // Two keys in ONE project share that project's quota, so a fallback
      // inside it buys nothing — and hides the fact that capacity never grew.
      logger.error("ai.pool.same_project", {
        projectId: fallbackProject,
        reason:
          "GEMINI_PRIMARY_PROJECT_ID and GEMINI_FALLBACK_PROJECT_ID are the same. " +
          "Gemini quota is per PROJECT, so a fallback key in the same project adds no capacity. " +
          "Fallback disabled — put the fallback key in a separate Google Cloud project.",
      });
    } else {
      providers.push({
        id: FALLBACK_PROVIDER_ID,
        projectId: fallbackProject,
        dailyLimit: geminiFallbackDailyLimit(),
        provider: new GeminiCategoryProvider(fallbackKey, shared),
      });
    }
  }

  return providers;
}

/** Cooldown rows for the given providers, keyed by id. */
async function readCooldowns(ids: string[]): Promise<Map<string, Date | null>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.aiProviderCooldown.findMany({ where: { provider: { in: ids } } });
  return new Map(rows.map((row) => [row.provider, row.cooldownUntil]));
}

/**
 * Parks a provider so the NEXT boutique skips it instead of re-discovering the
 * same outage. Durable on purpose: each process-next is its own serverless
 * invocation, so in-memory state would not survive between them.
 */
export async function markProviderCooldown(
  providerId: string,
  reason: { status?: number; error: string },
  now: Date = new Date(),
): Promise<Date> {
  const cooldownUntil = new Date(now.getTime() + providerCooldownMs());
  const data = {
    cooldownUntil,
    lastStatus: reason.status ?? null,
    lastError: reason.error.slice(0, 500),
  };
  await prisma.aiProviderCooldown.upsert({
    where: { provider: providerId },
    update: data,
    create: { provider: providerId, ...data },
  });
  logger.warn("ai.pool.cooldown", {
    provider: providerId,
    status: reason.status ?? null,
    cooldownUntil: cooldownUntil.toISOString(),
    error: reason.error.slice(0, 200),
  });
  return cooldownUntil;
}

/** Per-provider budget and health, for gating and for reporting. */
export async function providerUsage(
  providers: PooledProvider[] = configuredProviders(),
  now: Date = new Date(),
): Promise<ProviderUsage[]> {
  const cooldowns = await readCooldowns(providers.map((p) => p.id));
  const dayStart = startOfBusinessDay(now);

  return Promise.all(
    providers.map(async (entry) => {
      const used = await prisma.importJob.count({
        where: { analyzedAt: { gte: dayStart }, analyzedBy: entry.id },
      });
      const raw = cooldowns.get(entry.id) ?? null;
      const cooldownUntil = raw && raw.getTime() > now.getTime() ? raw : null;
      return {
        id: entry.id,
        projectId: entry.projectId,
        used,
        limit: entry.dailyLimit,
        cooldownUntil,
        available: used < entry.dailyLimit && cooldownUntil === null,
      };
    }),
  );
}

/** Whether any provider could run right now. Used by the queue's pre-check. */
export async function anyProviderAvailable(now: Date = new Date()): Promise<{
  available: boolean;
  usage: ProviderUsage[];
}> {
  const providers = configuredProviders();
  // No key configured at all: the disabled provider runs, costs nothing, and
  // must not stop the queue.
  if (providers.length === 0) return { available: true, usage: [] };
  const usage = await providerUsage(providers, now);
  return { available: usage.some((u) => u.available), usage };
}

/**
 * Throws when no project can run. Callers use it to bail out EARLY — before
 * scraping or mutating anything — so a refused import costs no Apify credit and
 * leaves no half-finished row.
 */
export async function assertProviderAvailable(
  context: Record<string, unknown> = {},
  now: Date = new Date(),
): Promise<void> {
  const { available, usage } = await anyProviderAvailable(now);
  if (!available) {
    logger.info("ai.pool.unavailable", { ...context, usage });
    throw new NoProviderAvailableError(usage);
  }
}

export interface PoolAnalysis {
  result: AiCategoryResult;
  /** Which provider produced it — recorded against the job. */
  providerId: string;
  providerName: string;
}

/** Classifies a failure: should the pool try the next provider? */
function isTransient(error: unknown): boolean {
  if (!(error instanceof AiCategoryProviderError)) return true; // timeout / network
  if (error.status === undefined) return true; // transport-level, no HTTP status
  if (PERMANENT_STATUS.has(error.status)) return false;
  return TRANSIENT_STATUS.has(error.status) || error.status >= 500;
}

/**
 * Runs the analysis through the provider chain.
 *
 * Tries each AVAILABLE provider once, in order. A transient failure cools that
 * provider down and moves on; a permanent one aborts immediately. Throws when
 * every provider is unavailable or has failed, which the queue turns into a
 * retryable ANALYSIS_FAILED.
 *
 * It does NOT record success — the caller does that only after the whole
 * analysis has landed, so `analyzedAt`/`analyzedBy` never outlive a job that
 * failed later on.
 */
export async function analyzeWithPool(
  request: AiCategoryRequest,
  options: { throwOnFailure?: boolean; context?: Record<string, unknown> } = {},
): Promise<PoolAnalysis> {
  const providers = configuredProviders({ throwOnFailure: true });
  const context = options.context ?? {};

  if (providers.length === 0) {
    // No key at all — behave exactly as before: contribute nothing, never fail.
    const result = await disabledAiCategoryProvider.analyze(request);
    return { result, providerId: "disabled", providerName: disabledAiCategoryProvider.name };
  }

  const usage = await providerUsage(providers);
  const byId = new Map(usage.map((u) => [u.id, u]));
  let lastError: unknown;
  let attempted = 0;

  for (const entry of providers) {
    const health = byId.get(entry.id);
    if (health && !health.available) {
      logger.info("ai.pool.skipped", {
        ...context,
        provider: entry.id,
        used: health.used,
        limit: health.limit,
        cooldownUntil: health.cooldownUntil?.toISOString() ?? null,
        reason: health.cooldownUntil ? "cooldown" : "daily-limit",
      });
      continue;
    }

    attempted += 1;
    try {
      const result = await entry.provider.analyze(request);
      logger.info("ai.pool.success", {
        ...context,
        provider: entry.id,
        projectId: entry.projectId,
        model: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
        attemptOrder: attempted,
      });
      return { result, providerId: entry.id, providerName: entry.provider.name };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof AiCategoryProviderError ? error.status : undefined;

      if (!isTransient(error)) {
        // A bad request or a rejected key fails identically everywhere, so
        // spending the next project's quota on it would only hide the problem.
        logger.warn("ai.pool.permanent_failure", {
          ...context,
          provider: entry.id,
          status: status ?? null,
          error: message,
        });
        throw error;
      }

      await markProviderCooldown(entry.id, { status, error: message });
    }
  }

  // Nothing ran, or everything that ran failed transiently.
  if (attempted === 0) throw new NoProviderAvailableError(usage);
  throw lastError instanceof Error
    ? lastError
    : new AiCategoryProviderError("All AI providers failed", { provider: "pool" });
}

/**
 * An {@link AiCategoryProvider} backed by the whole pool.
 *
 * Exists so the detection pipeline stays untouched: it still receives one
 * provider and calls `analyze()`, while failover happens underneath. After a
 * successful call, `lastProviderId` names the project that produced it, which
 * is what gets recorded against the job.
 */
export interface PooledProviderHandle extends AiCategoryProvider {
  readonly lastProviderId: string | null;
}

class PoolBackedProvider implements PooledProviderHandle {
  // Keeps the historical name, so `name !== "disabled"` checks still mean
  // "a real model ran" without knowing about the pool.
  readonly name = "gemini";
  lastProviderId: string | null = null;

  constructor(private readonly options: { context?: Record<string, unknown> } = {}) {}

  async analyze(request: AiCategoryRequest): Promise<AiCategoryResult> {
    const outcome = await analyzeWithPool(request, this.options);
    this.lastProviderId = outcome.providerId;
    return outcome.result;
  }
}

/**
 * The provider the pipeline should use: pool-backed when any key is configured,
 * the disabled provider otherwise (unchanged, fully backward compatible).
 */
export function resolvePooledProvider(
  options: { context?: Record<string, unknown> } = {},
): PooledProviderHandle {
  const providers = configuredProviders();
  logger.info("ai.pool.resolved", {
    ...(options.context ?? {}),
    providers: providers.map((p) => ({
      id: p.id,
      projectId: p.projectId,
      dailyLimit: p.dailyLimit,
    })),
    model: providers.length > 0 ? (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) : null,
  });

  if (providers.length === 0) {
    return { name: disabledAiCategoryProvider.name, lastProviderId: null, analyze: (r) => disabledAiCategoryProvider.analyze(r) };
  }
  return new PoolBackedProvider(options);
}
