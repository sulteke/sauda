import "server-only";

import {
  geminiFallbackDailyLimit,
  geminiPrimaryDailyLimit,
  providerCooldownMs,
  rateLimitCooldownMs,
} from "@/config/limits";
import {
  type AiCategoryProvider,
  AiCategoryProviderError,
  type AiCategoryRequest,
  type AiCategoryResult,
  disabledAiCategoryProvider,
} from "@/lib/ai-category-provider";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

import { DailyAnalysisLimitError } from "./analysis-budget";
import { DEFAULT_GEMINI_MODEL, GeminiCategoryProvider } from "./gemini-category-provider";
import { exhaustBucket, ledgerUsage, reserveRequest } from "./request-ledger";

/**
 * Provider pool — the ONE place that decides which AI provider runs, and what
 * happens when it fails.
 *
 * Gemini's rate limits apply per Google Cloud PROJECT, so a second API key only
 * adds capacity when it lives in a different project. The pool therefore treats
 * providers as independent projects: each has its own daily budget, its own
 * cooldown, and its own counter. Nothing here pools them into a single number.
 *
 * Failure handling is deliberately asymmetric, and the line is drawn around
 * WHOSE fault it is:
 *   - the REQUEST is malformed (400) or names a model that does not exist
 *     (404) → the next project would fail identically, so fail immediately
 *     rather than burn a second quota proving it;
 *   - anything else — quota (429), outage (5xx), timeout, network, and
 *     crucially a rejected or restricted key (401 / 403) → belongs to THIS
 *     project alone. Park it in cooldown and try the next one.
 *
 * That 401/403 line was learned the hard way: a fallback project sitting in
 * Google's "API access is restricted, set up billing" state answered 403, and
 * treating that as permanent aborted analyses the healthy project could have
 * completed. A rejected credential says nothing about the other project's.
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

/**
 * The only statuses that are the REQUEST's fault rather than the project's: a
 * malformed body, or a model name that does not exist. Both fail identically
 * everywhere, so failing over just spends a second project's quota to learn the
 * same thing. Everything else — 401/403 (this key or project is rejected), 429
 * (this project's quota), 5xx and timeouts — is provider-scoped and DOES fail
 * over.
 */
const REQUEST_FAULT_STATUS = new Set([400, 404]);

export interface PooledProvider {
  /** "primary" / "fallback" — the identity used everywhere else. */
  id: string;
  /** Google Cloud project this key belongs to (quota is per project). */
  projectId: string | null;
  /** Model this entry sends to; the quota bucket is project + model. */
  model: string;
  /** AI REQUESTS per quota day allowed on this project. */
  dailyLimit: number;
  provider: AiCategoryProvider;
}

export interface ProviderUsage {
  id: string;
  projectId: string | null;
  model: string;
  /** Requests SENT today — retries and failures included. */
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
      .map(
        (u) => `${u.id} ${u.used}/${u.limit} requests${u.cooldownUntil ? " (cooling down)" : ""}`,
      )
      .join(", ");
    this.message = `No AI provider available right now — ${detail}.`;
  }
}

/**
 * Attempts one project gets before the pool moves on.
 *
 * Two, not three. A retry earns its place when the overload is a blip — one
 * short wait and the same project answers. It stops earning anything once the
 * overload is sustained, and measurement says that is the common case: a day
 * of 503s spent 29 requests to produce 5 analyses, because every boutique
 * burned three attempts per project before moving on. Two caps the worst case
 * at four requests instead of six while still covering the blip.
 *
 * Overridable: GEMINI_POOL_MAX_ATTEMPTS.
 */
function pooledMaxAttempts(): number {
  const env = Number(process.env.GEMINI_POOL_MAX_ATTEMPTS);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 2;
}

/**
 * Wall-clock budget for the WHOLE pooled call — every project, every retry. It
 * must leave the process-next route (60s) room for the queue's own DB work and
 * a cold start.
 */
const POOL_BUDGET_MS = 45_000;
/**
 * Most of that budget one project may take. Without a cap, a project that fails
 * SLOWLY would starve the next one; with it, a healthy fallback still gets a
 * full-length attempt plus a retry. A project that fails FAST (a 429 answers in
 * under a second) simply leaves the rest of the budget to whoever follows.
 */
const PROVIDER_MAX_BUDGET_MS = 28_000;
/** Below this there is no point starting a project: it could not finish. */
const MIN_PROVIDER_BUDGET_MS = 6_000;

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

  const model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const providers: PooledProvider[] = [];

  /** Each attempt takes a ledger slot before it is allowed to go out. */
  const reserve = (id: string, limit: number) => () => reserveRequest(id, model, limit);
  // Each project retries its own transient faults before we give up on it. A
  // 503 means the MODEL is busy, not that the project is unwell, so switching
  // projects lands on the same busy model a second later — and parks both.
  // Which is also why the retry count is small: when the overload is real it
  // covers the whole model, and extra attempts only spend quota to confirm it.
  //
  // The time budget is NOT fixed here: analyzeWithPool passes what is actually
  // left when each project's turn comes.
  const shared = { throwOnFailure: options.throwOnFailure, maxAttempts: pooledMaxAttempts() };

  if (primaryKey) {
    const dailyLimit = geminiPrimaryDailyLimit();
    providers.push({
      id: PRIMARY_PROVIDER_ID,
      projectId: primaryProject,
      model,
      dailyLimit,
      provider: new GeminiCategoryProvider(primaryKey, {
        ...shared,
        beforeRequest: reserve(PRIMARY_PROVIDER_ID, dailyLimit),
      }),
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
      const dailyLimit = geminiFallbackDailyLimit();
      providers.push({
        id: FALLBACK_PROVIDER_ID,
        projectId: fallbackProject,
        model,
        dailyLimit,
        provider: new GeminiCategoryProvider(fallbackKey, {
          ...shared,
          beforeRequest: reserve(FALLBACK_PROVIDER_ID, dailyLimit),
        }),
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
  reason: { status?: number; error: string; durationMs?: number },
  now: Date = new Date(),
): Promise<Date> {
  const cooldownUntil = new Date(now.getTime() + (reason.durationMs ?? providerCooldownMs()));
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
  // Requests SENT, from the ledger — not finished analyses. Google's allowance
  // counts every request, so a counter built on successes reads far too low.
  const ledger = await ledgerUsage(
    providers.map((p) => ({ provider: p.id, model: p.model, limit: p.dailyLimit })),
    now,
  );
  const usedById = new Map(ledger.map((row) => [row.provider, row.used]));

  return providers.map((entry) => {
    const used = usedById.get(entry.id) ?? 0;
    const raw = cooldowns.get(entry.id) ?? null;
    const cooldownUntil = raw && raw.getTime() > now.getTime() ? raw : null;
    return {
      id: entry.id,
      projectId: entry.projectId,
      model: entry.model,
      used,
      limit: entry.dailyLimit,
      cooldownUntil,
      available: used < entry.dailyLimit && cooldownUntil === null,
    };
  });
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

/**
 * Should the pool try the next project?
 *
 * Yes for anything the project itself is answerable for, no for a request that
 * is wrong on its face. Unknown shapes (timeouts, network errors, statuses we
 * have not seen) fail over: an unnecessary second attempt is far cheaper than
 * abandoning an analysis a healthy project would have completed.
 */
function shouldFailOver(error: unknown): boolean {
  if (!(error instanceof AiCategoryProviderError)) return true; // timeout / network
  if (error.status === undefined) return true; // transport-level, no HTTP status
  return !REQUEST_FAULT_STATUS.has(error.status);
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
  const poolDeadline = Date.now() + POOL_BUDGET_MS;
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

    const budgetMs = Math.min(poolDeadline - Date.now(), PROVIDER_MAX_BUDGET_MS);
    if (budgetMs < MIN_PROVIDER_BUDGET_MS) {
      // Whatever ran before used the request's time; starting here would only
      // abort mid-flight. The item stays retryable, with nothing spent.
      logger.warn("ai.pool.out_of_time", { ...context, provider: entry.id, budgetMs });
      break;
    }

    attempted += 1;
    try {
      const result = await entry.provider.analyze(request, { budgetMs });
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

      if (!shouldFailOver(error)) {
        // The request itself is wrong; every project would reject it the same
        // way, so spending another quota on it would only hide the problem.
        logger.warn("ai.pool.request_fault", {
          ...context,
          provider: entry.id,
          status: status ?? null,
          error: message,
        });
        throw error;
      }

      const quotaScope =
        error instanceof AiCategoryProviderError ? error.quotaScope : undefined;

      if (quotaScope === "per-day") {
        // The project's own count is authoritative and is ahead of ours. Spend
        // the rest of its ledger so no further request is sent today, and skip
        // the cooldown — a ten-minute wait cannot bring back a spent day.
        await exhaustBucket(entry.id, entry.model, entry.dailyLimit);
        logger.warn("ai.pool.daily_quota_gone", {
          ...context,
          provider: entry.id,
          model: entry.model,
          error: message,
        });
      } else {
        // A per-minute bounce clears in seconds; parking the project for ten
        // minutes would throw away an allowance that is still there.
        await markProviderCooldown(entry.id, {
          status,
          error: message,
          ...(quotaScope === "per-minute" ? { durationMs: rateLimitCooldownMs() } : {}),
        });
      }
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
