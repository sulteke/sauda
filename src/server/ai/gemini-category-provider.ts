import "server-only";

import {
  type AiCategoryProvider,
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
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

  constructor(apiKey: string, options: GeminiProviderOptions = {}) {
    this.apiKey = apiKey;
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

  async analyze(request: AiCategoryRequest): Promise<AiCategoryResult> {
    const prompt = buildAiCategoryPrompt(request);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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
          logger.warn("gemini.retrying", {
            provider: this.name,
            model: this.model,
            status: response.status,
            attempt,
            maxAttempts: this.maxAttempts,
            durationMs,
          });
          await delay(this.retryDelayMs * attempt);
          continue;
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
        return { ...EMPTY_AI_RESULT };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < this.maxAttempts) {
          logger.warn("gemini.retrying", {
            provider: this.name,
            model: this.model,
            error: message,
            attempt,
            maxAttempts: this.maxAttempts,
            durationMs,
          });
          await delay(this.retryDelayMs * attempt);
          continue;
        }
        logger.warn("gemini.request_error", {
          provider: this.name,
          model: this.model,
          error: message,
          attempt,
          durationMs,
        });
        return { ...EMPTY_AI_RESULT };
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
export function resolveAiCategoryProvider(): AiCategoryProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  logger.info("gemini.provider_selected", {
    provider: apiKey ? "gemini" : "disabled",
    apiKeyDetected: Boolean(apiKey),
    apiKeyLength: (apiKey ?? "").length,
    model: apiKey ? (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) : null,
  });
  if (!apiKey) return disabledAiCategoryProvider;
  return new GeminiCategoryProvider(apiKey);
}
