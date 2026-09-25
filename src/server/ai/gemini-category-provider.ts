import "server-only";

import {
  type AiBatchItem,
  type AiBatchResult,
  type AiCategoryAnalyzeOptions,
  type AiCategoryProvider,
  AiCategoryProviderError,
  type AiCategoryRequest,
  type AiCategoryResult,
  type QuotaScope,
  buildAiBatchPrompt,
  buildAiCategoryPrompt,
  disabledAiCategoryProvider,
  EMPTY_AI_RESULT,
  parseAiBatchResult,
  parseAiCategoryResult,
} from "@/lib/ai-category-provider";
import { logger } from "@/lib/logger";

/**
 * Real AI provider backed by the Google Gemini API (text only — no images).
 * Reuses the shared prompt builder and strict JSON parser. All Gemini specifics
 * (endpoint, payload, token accounting, retries) live here, behind the
 * AiCategoryProvider interface, so the pipeline is unaffected.
 */

/** Gemini Flash model suited to structured JSON. Overridable via GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 600;
/**
 * Server-side faults worth retrying against the SAME project: the model is
 * briefly busy (503 "high demand" from Flash is the common one) and a short
 * wait clears it. 429 is deliberately absent — a rate limit belongs to the
 * project, so waiting on it wastes the budget while the OTHER project sits
 * idle. The pool switches projects for that instead.
 */
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
/**
 * Spread applied to each backoff wait (±25%). Several imports can hit the same
 * busy model at once; without jitter they would retry on the same beat and
 * collide again.
 */
const BACKOFF_JITTER = 0.25;
/**
 * Default wall-clock budget for a whole analyze() call (all attempts + all
 * backoff waits), used when the caller sets none. It bounds the total so the
 * enclosing request stays under the serverless function limit. Enforced by (a)
 * capping each attempt's fetch timeout to the time left, and (b) never sleeping
 * past the deadline. A pool that will try SEVERAL projects in one request
 * passes a smaller budget, so their sum still fits.
 */
const DEFAULT_ANALYZE_BUDGET_MS = 40_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads WHICH limit a 429 hit out of Google's error body. The violation names
 * the quota, e.g. "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" or
 * "...PerDayPerProjectPerModel-FreeTier". Null when the body does not say —
 * the caller then has to assume the cautious case.
 */
export function parseQuotaScope(body: string): QuotaScope | null {
  if (/PerDay/i.test(body)) return "per-day";
  if (/PerMinute/i.test(body)) return "per-minute";
  return null;
}

/**
 * Exponential backoff with jitter: 600ms → 1200ms → 2400ms, each spread by
 * BACKOFF_JITTER. A base of 0 yields 0, so tests stay instant and exact.
 */
function backoffMs(base: number, attempt: number): number {
  const exponential = base * 2 ** (attempt - 1);
  const spread = exponential * BACKOFF_JITTER;
  return Math.max(0, Math.round(exponential - spread + Math.random() * 2 * spread));
}

export interface GeminiProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /**
   * Called before EVERY HTTP attempt, retries included. Returning false means
   * the caller has no request allowance left, and the provider sends nothing.
   * This is where the request ledger takes its slot, so the count matches what
   * actually went out rather than what came back.
   */
  beforeRequest?: () => Promise<boolean>;
  /**
   * Wall-clock budget for a whole analyze() call — every attempt and every
   * backoff wait. The pool shrinks it so that trying BOTH projects, each with
   * retries, still fits inside the route's function limit.
   */
  analyzeBudgetMs?: number;
  /**
   * When true, a terminal failure throws `AiCategoryProviderError` instead of
   * degrading to an empty result. The import queue's Analyze stage opts in so a
   * Gemini outage becomes a retryable ANALYSIS_FAILED rather than a silent
   * keyword-only boutique. Defaults to false (graceful degradation).
   */
  throwOnFailure?: boolean;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: GeminiUsage;
}

export class GeminiCategoryProvider implements AiCategoryProvider {
  readonly name = "gemini";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly analyzeBudgetMs: number;
  private readonly beforeRequest?: () => Promise<boolean>;
  private readonly throwOnFailure: boolean;

  constructor(apiKey: string, options: GeminiProviderOptions = {}) {
    this.apiKey = apiKey;
    this.throwOnFailure = options.throwOnFailure ?? false;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const envTimeout = Number(process.env.GEMINI_TIMEOUT_MS);
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    const envAttempts = Number(process.env.GEMINI_MAX_ATTEMPTS);
    this.maxAttempts =
      options.maxAttempts ??
      (Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : DEFAULT_MAX_ATTEMPTS);
    const envRetryDelay = Number(process.env.GEMINI_RETRY_DELAY_MS);
    this.retryDelayMs =
      options.retryDelayMs ??
      (Number.isFinite(envRetryDelay) && envRetryDelay >= 0
        ? envRetryDelay
        : DEFAULT_RETRY_DELAY_MS);
    this.analyzeBudgetMs = options.analyzeBudgetMs ?? DEFAULT_ANALYZE_BUDGET_MS;
    this.beforeRequest = options.beforeRequest;
  }

  /** The API key lives only in the query string; never log this URL. */
  private endpoint(): string {
    return `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  /**
   * Terminal outcome of a failed request: throw when the caller opted into
   * strict mode, otherwise degrade to an empty result (the historical default).
   */
  private fail(reason: {
    status?: number;
    message: string;
    cause?: unknown;
    quotaScope?: QuotaScope;
  }): AiCategoryResult {
    if (this.throwOnFailure) {
      throw new AiCategoryProviderError(reason.message, {
        provider: this.name,
        status: reason.status,
        cause: reason.cause,
        quotaScope: reason.quotaScope,
      });
    }
    return { ...EMPTY_AI_RESULT };
  }

  /**
   * Sends ONE prompt and returns the model's raw text, retrying transient
   * faults. Always THROWS `AiCategoryProviderError` on a terminal failure — the
   * graceful-degradation policy belongs to the caller, because "empty result"
   * is a sane answer for one shop and a dangerous one for a batch.
   */
  private async request(
    prompt: string,
    options: AiCategoryAnalyzeOptions,
    label: string,
  ): Promise<string> {
    // Hard deadline for the whole call — every attempt and every backoff wait.
    const deadline = Date.now() + (options.budgetMs ?? this.analyzeBudgetMs);
    let last: AiCategoryProviderError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      // Stop if there isn't enough time left for a useful attempt.
      const budgetLeft = deadline - Date.now();
      if (budgetLeft <= 1_000) break;

      // Take a request slot BEFORE going out, so the ledger counts what was
      // actually sent. No slot means no request — not even a retry.
      if (this.beforeRequest && !(await this.beforeRequest())) {
        logger.warn("gemini.request_budget_spent", {
          provider: this.name,
          model: this.model,
          label,
          attempt,
        });
        throw new AiCategoryProviderError(
          `Gemini request budget spent for ${this.model} today`,
          { provider: this.name, quotaScope: "per-day" },
        );
      }

      const controller = new AbortController();
      // Cap this attempt to the smaller of the per-request timeout and time left,
      // so no attempt can push the call past the deadline.
      const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, budgetLeft));
      const startedAt = Date.now();

      try {
        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          }),
          signal: controller.signal,
        });
        const durationMs = Date.now() - startedAt;

        if (response.ok) {
          const payload = (await response.json()) as GeminiResponse;
          const usage = payload.usageMetadata ?? {};
          logger.info("gemini.request_ok", {
            provider: this.name,
            model: this.model,
            label,
            attempt,
            promptTokens: usage.promptTokenCount ?? null,
            responseTokens: usage.candidatesTokenCount ?? null,
            totalTokens: usage.totalTokenCount ?? null,
            durationMs,
          });
          return (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
        }

        // Non-2xx. Read the body once so the exact Google error is diagnosable.
        // Logged at WARN (console.warn) — visible in Vercel logs (unlike console.log).
        const body = await response.text().catch(() => "");
        last = new AiCategoryProviderError(
          `Gemini request failed (${response.status} ${response.statusText})`,
          {
            provider: this.name,
            status: response.status,
            // A 429 names the limit it hit; the pool reacts very differently to
            // "this minute is full" than to "this day is gone".
            quotaScope: response.status === 429 ? (parseQuotaScope(body) ?? undefined) : undefined,
          },
        );

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxAttempts) {
          const deadlineLeft = Math.max(0, deadline - Date.now());
          const waitMs = Math.min(backoffMs(this.retryDelayMs, attempt), deadlineLeft);
          // Only retry while a further attempt could still finish in time.
          if (deadlineLeft > waitMs + 1_000) {
            logger.warn("gemini.retrying", {
              provider: this.name,
              model: this.model,
              label,
              status: response.status,
              attempt,
              maxAttempts: this.maxAttempts,
              waitMs,
              durationMs,
            });
            if (waitMs > 0) await delay(waitMs);
            continue;
          }
          // Out of time — fall through and fail with what we have.
        }
        logger.warn("gemini.request_failed", {
          provider: this.name,
          model: this.model,
          label,
          status: response.status,
          statusText: response.statusText,
          body: body.slice(0, 1000),
          attempt,
          durationMs,
        });
        throw last;
      } catch (error) {
        // A failure we raised for a non-OK response must bubble out as-is (with
        // its status), not be rewrapped as a transport error.
        if (error instanceof AiCategoryProviderError) throw error;

        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        const deadlineLeft = Math.max(0, deadline - Date.now());
        if (attempt < this.maxAttempts && deadlineLeft > 1_000) {
          logger.warn("gemini.retrying", {
            provider: this.name,
            model: this.model,
            label,
            error: message,
            attempt,
            maxAttempts: this.maxAttempts,
            durationMs,
          });
          await delay(Math.min(backoffMs(this.retryDelayMs, attempt), deadlineLeft));
          continue;
        }
        logger.warn("gemini.request_error", {
          provider: this.name,
          model: this.model,
          label,
          error: message,
          attempt,
          durationMs,
        });
        throw new AiCategoryProviderError(`Gemini request error: ${message}`, {
          provider: this.name,
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    // Out of attempts or out of time.
    throw (
      last ??
      new AiCategoryProviderError(`Gemini request ran out of time before any attempt completed`, {
        provider: this.name,
      })
    );
  }

  async analyze(
    request: AiCategoryRequest,
    options: AiCategoryAnalyzeOptions = {},
  ): Promise<AiCategoryResult> {
    try {
      const text = await this.request(buildAiCategoryPrompt(request), options, "analyze");
      const result = parseAiCategoryResult(text);
      logger.info("gemini.analyze_parsed", {
        provider: this.name,
        model: this.model,
        categories: result.categories.length,
        hashtags: result.hashtags.length,
      });
      return result;
    } catch (error) {
      if (!(error instanceof AiCategoryProviderError)) throw error;
      // Historical default: one flaky shop degrades to an empty result rather
      // than crashing an import. Strict callers opt out.
      if (this.throwOnFailure) throw error;
      return { ...EMPTY_AI_RESULT };
    }
  }

  /**
   * Analyzes SEVERAL shops in one request.
   *
   * Always throws on failure, whatever `throwOnFailure` says: degrading a batch
   * to an empty result would mark every shop in it as "analyzed, no categories"
   * — a silent wrong answer for all of them at once. A thrown error leaves them
   * retryable instead.
   *
   * A reply that arrives but does not validate is NOT retried. The HTTP call
   * already succeeded, so a second one would spend another slot of a very small
   * daily allowance to re-roll the same model at temperature 0.2; the items stay
   * retryable and cost nothing in the meantime.
   */
  async analyzeBatch(
    items: readonly AiBatchItem[],
    options: AiCategoryAnalyzeOptions = {},
  ): Promise<AiBatchResult> {
    const handles = items.map((i) => i.handle);
    const text = await this.request(buildAiBatchPrompt(items), options, "batch");
    const batch = parseAiBatchResult(text, handles);
    logger.info("gemini.batch_parsed", {
      provider: this.name,
      model: this.model,
      size: items.length,
      results: batch.results.size,
      skipped: batch.skipped.length,
    });
    return batch;
  }
}

/**
 * Env-gated resolver: returns a GeminiCategoryProvider when GEMINI_API_KEY is
 * set, otherwise the disabled provider (no crash, fully backward compatible).
 * This is the single place the real provider is selected. `apiKeyLength` helps
 * catch a truncated / whitespace-padded key without ever logging the value.
 */
export function resolveAiCategoryProvider(
  options: { throwOnFailure?: boolean } = {},
): AiCategoryProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  logger.info("gemini.provider_selected", {
    provider: apiKey ? "gemini" : "disabled",
    apiKeyDetected: Boolean(apiKey),
    apiKeyLength: (apiKey ?? "").length,
    model: apiKey ? (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) : null,
    throwOnFailure: Boolean(options.throwOnFailure),
  });
  if (!apiKey) return disabledAiCategoryProvider;
  return new GeminiCategoryProvider(apiKey, { throwOnFailure: options.throwOnFailure });
}
