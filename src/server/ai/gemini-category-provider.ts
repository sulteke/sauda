import "server-only";

import {
  type AiCategoryProvider,
  AiCategoryProviderError,
  type AiCategoryRequest,
  type AiCategoryResult,
  buildAiCategoryPrompt,
  disabledAiCategoryProvider,
  EMPTY_AI_RESULT,
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
/** Transient statuses worth retrying — notably 503 "high demand" from Flash. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/**
 * Hard wall-clock budget for a whole analyze() call (all attempts + all backoff
 * waits). It bounds the total so the enclosing process-next request stays safely
 * under Vercel's 60s function limit: with ~40s here, ≥20s remains for queue/DB
 * overhead and cold start. Enforced by (a) capping each attempt's fetch timeout
 * to the time left, and (b) never sleeping past the deadline.
 */
const ANALYZE_BUDGET_MS = 40_000;
/**
 * Cap on the CUMULATIVE 429 backoff wait within one analyze() call (a subset of
 * ANALYZE_BUDGET_MS). Kept small so a rate-limit spike is retried briefly, not
 * for the whole budget; sustained 429 fails fast → retryable ANALYSIS_FAILED.
 */
const RETRY_429_BUDGET_MS = 10_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts Google's advised retry delay (RetryInfo.retryDelay, e.g. "27s" or
 * "1.5s") from a 429 error body, in milliseconds. Returns null when absent or
 * unparsable, so the caller can fall back to exponential backoff.
 */
function parseRetryDelayMs(body: string): number | null {
  try {
    const details = (JSON.parse(body) as { error?: { details?: unknown } })?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const detail of details) {
      const value = (detail as { retryDelay?: unknown })?.retryDelay;
      if (typeof value === "string") {
        const seconds = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim())?.[1];
        if (seconds) return Math.round(Number.parseFloat(seconds) * 1000);
      }
    }
  } catch {
    // Non-JSON body — fall back to exponential backoff.
  }
  return null;
}

export interface GeminiProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
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
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** The API key lives only in the query string; never log this URL. */
  private endpoint(): string {
    return `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  /**
   * Terminal outcome of a failed request: throw when the caller opted into
   * strict mode, otherwise degrade to an empty result (the historical default).
   */
  private fail(reason: { status?: number; message: string; cause?: unknown }): AiCategoryResult {
    if (this.throwOnFailure) {
      throw new AiCategoryProviderError(reason.message, {
        provider: this.name,
        status: reason.status,
        cause: reason.cause,
      });
    }
    return { ...EMPTY_AI_RESULT };
  }

  async analyze(request: AiCategoryRequest): Promise<AiCategoryResult> {
    const prompt = buildAiCategoryPrompt(request);
    // Hard deadline for the whole call, plus a small cumulative 429 wait budget.
    const deadline = Date.now() + ANALYZE_BUDGET_MS;
    let backoff429BudgetMs = RETRY_429_BUDGET_MS;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      // Stop if there isn't enough time left for a useful attempt.
      const budgetLeft = deadline - Date.now();
      if (budgetLeft <= 1_000) break;

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
          const text = (payload.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("");
          const result = parseAiCategoryResult(text);
          const usage = payload.usageMetadata ?? {};
          logger.info("gemini.request_ok", {
            provider: this.name,
            model: this.model,
            attempt,
            promptTokens: usage.promptTokenCount ?? null,
            responseTokens: usage.candidatesTokenCount ?? null,
            totalTokens: usage.totalTokenCount ?? null,
            durationMs,
            categories: result.categories.length,
          });
          return result;
        }

        // Non-2xx. Read the body once so the exact Google error is diagnosable.
        // Logged at WARN (console.warn) — visible in Vercel logs (unlike console.log).
        const body = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxAttempts) {
          let canRetry = true;
          let waitMs: number;
          if (response.status === 429) {
            // Rate limited: honor Google's retryDelay hint, else exponential
            // 1s → 2s → 4s, capped by the remaining cumulative 429 budget. When
            // the budget is spent, stop retrying so the request can't approach
            // the function limit — the item becomes retryable ANALYSIS_FAILED.
            const deadlineLeft = Math.max(0, deadline - Date.now());
            if (backoff429BudgetMs <= 0 || deadlineLeft <= 1_000) {
              canRetry = false;
              waitMs = 0;
            } else {
              const hintedMs = parseRetryDelayMs(body);
              const exponentialMs = 1_000 * 2 ** (attempt - 1);
              // Cap by the 429 budget AND the overall deadline.
              waitMs = Math.min(hintedMs ?? exponentialMs, backoff429BudgetMs, deadlineLeft);
              backoff429BudgetMs -= waitMs;
            }
          } else {
            waitMs = this.retryDelayMs * attempt; // unchanged for 408 / 5xx
          }

          if (canRetry) {
            logger.warn("gemini.retrying", {
              provider: this.name,
              model: this.model,
              status: response.status,
              attempt,
              maxAttempts: this.maxAttempts,
              waitMs,
              durationMs,
            });
            if (waitMs > 0) await delay(waitMs);
            continue;
          }
          // 429 backoff budget exhausted — fall through to fail; the queue marks
          // ANALYSIS_FAILED (parsed data preserved, retryable later, no re-scrape).
        }
        logger.warn("gemini.request_failed", {
          provider: this.name,
          model: this.model,
          status: response.status,
          statusText: response.statusText,
          body: body.slice(0, 1000),
          attempt,
          durationMs,
        });
        return this.fail({
          status: response.status,
          message: `Gemini request failed (${response.status} ${response.statusText})`,
        });
      } catch (error) {
        // A strict-mode failure we raised for a non-OK response must bubble out
        // as-is (with its status), not be rewrapped as a transport error.
        if (error instanceof AiCategoryProviderError) throw error;

        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        const deadlineLeft = Math.max(0, deadline - Date.now());
        if (attempt < this.maxAttempts && deadlineLeft > 1_000) {
          logger.warn("gemini.retrying", {
            provider: this.name,
            model: this.model,
            error: message,
            attempt,
            maxAttempts: this.maxAttempts,
            durationMs,
          });
          await delay(Math.min(this.retryDelayMs * attempt, deadlineLeft));
          continue;
        }
        logger.warn("gemini.request_error", {
          provider: this.name,
          model: this.model,
          error: message,
          attempt,
          durationMs,
        });
        return this.fail({ message: `Gemini request error: ${message}`, cause: error });
      } finally {
        clearTimeout(timeout);
      }
    }

    return { ...EMPTY_AI_RESULT }; // unreachable; the loop always returns
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
