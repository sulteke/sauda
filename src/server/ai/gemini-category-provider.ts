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
 * (endpoint, payload, token accounting) live here, behind the AiCategoryProvider
 * interface, so the pipeline is unaffected.
 */

/** Latest stable Gemini Flash model suited to structured JSON. One place to change it. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GeminiProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
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

  constructor(apiKey: string, options: GeminiProviderOptions = {}) {
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const envTimeout = Number(process.env.GEMINI_TIMEOUT_MS);
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  }

  /** The API key lives only in the query string; never log this URL. */
  private endpoint(): string {
    return `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  async analyze(request: AiCategoryRequest): Promise<AiCategoryResult> {
    const prompt = buildAiCategoryPrompt(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    // TEMP debug logging — remove later.
    console.log("GEMINI_REQUEST_STARTED", { provider: this.name, model: this.model });

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

      // TEMP debug logging — remove later.
      console.log("GEMINI_REQUEST_FINISHED", {
        provider: this.name,
        model: this.model,
        status: response.status,
        durationMs,
      });

      if (!response.ok) {
        // TEMP debug logging — remove later. Full error body (never the key/URL).
        console.log("GEMINI_ERROR_BODY", {
          status: response.status,
          statusText: response.statusText,
          body: await response.text(),
        });
        // TEMP debug logging — remove later.
        logger.info("gemini.debug.request_failed", {
          provider: this.name,
          model: this.model,
          status: response.status,
          durationMs,
        });
        // Never log the URL/key — only safe metadata.
        logger.warn("gemini.request_failed", {
          provider: this.name,
          model: this.model,
          status: response.status,
          durationMs,
        });
        return { ...EMPTY_AI_RESULT };
      }

      const payload = (await response.json()) as GeminiResponse;
      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      // TEMP debug logging — remove later. Raw model text before parsing.
      console.log("GEMINI_RAW_RESPONSE_TEXT", text);
      const result = parseAiCategoryResult(text);
      const usage = payload.usageMetadata ?? {};

      logger.info("gemini.request_ok", {
        provider: this.name,
        model: this.model,
        promptTokens: usage.promptTokenCount ?? null,
        responseTokens: usage.candidatesTokenCount ?? null,
        totalTokens: usage.totalTokenCount ?? null,
        durationMs,
        categories: result.categories.length,
      });

      return result;
    } catch (error) {
      // TEMP debug logging — remove later.
      logger.info("gemini.debug.request_failed", {
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn("gemini.request_error", {
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...EMPTY_AI_RESULT };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Env-gated resolver: returns a GeminiCategoryProvider when GEMINI_API_KEY is
 * set, otherwise the disabled provider (exactly as before — no crash, fully
 * backward compatible). This is the single place the real provider is selected.
 */
export function resolveAiCategoryProvider(): AiCategoryProvider {
  const apiKey = process.env.GEMINI_API_KEY;
  // TEMP debug logging — remove later. Logs selection only (never the key value).
  console.log("GEMINI_PROVIDER_SELECTED", {
    apiKeyDetected: Boolean(apiKey),
    model: apiKey ? (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) : null,
  });
  if (!apiKey) return disabledAiCategoryProvider;
  return new GeminiCategoryProvider(apiKey);
}
