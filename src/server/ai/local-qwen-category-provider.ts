import "server-only";

import { localAiBaseUrl, localAiMaxTokens, localAiModel } from "@/config/limits";
import {
  type AiBatchItem,
  type AiBatchResult,
  type AiCategoryAnalyzeOptions,
  type AiCategoryProvider,
  AiCategoryProviderError,
  type AiCategoryRequest,
  type AiCategoryResult,
  buildAiBatchPrompt,
  buildAiCategoryPrompt,
  parseAiBatchResult,
  parseAiCategoryResult,
  stripJsonFence,
} from "@/lib/ai-category-provider";
import { logger } from "@/lib/logger";

/**
 * A model running on the developer's own machine, spoken to over LM Studio's
 * OpenAI-compatible endpoint.
 *
 * It exists for one reason: Gemini's free tier is small and its Flash models
 * spend whole afternoons returning 503, which stops local work dead. A local
 * model has no quota and no shared load, so it can finish the queue when both
 * Google projects will not. It is deliberately LAST in the pool — it is slower
 * and smaller than Gemini, so it should only ever run when nothing better can.
 *
 * It sends the SAME prompts as Gemini and validates with the SAME parsers. A
 * second taxonomy would be worse than no local model at all: shops analyzed on
 * a laptop would quietly carry different categories than shops analyzed in
 * production, and nobody would see the seam until much later.
 */

/**
 * Qwen reasons out loud by default, and its reasoning is billed against the
 * same output budget as the answer — long enough and the JSON is truncated
 * mid-object. `/no_think` turns that off, which is what makes the model usable
 * for structured output at all.
 */
const NO_THINK = "/no_think";

/** Local models have no shared load to wait out, so one attempt is the honest number. */
const MAX_ATTEMPTS = 1;
/** A local server is either up or it is not; this only stops a hang. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
}

export interface LocalQwenProviderOptions {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class LocalQwenCategoryProvider implements AiCategoryProvider {
  readonly name = "local-qwen";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: LocalQwenProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? localAiBaseUrl()).replace(/\/+$/, "");
    this.model = options.model ?? localAiModel();
    this.maxTokens = options.maxTokens ?? localAiMaxTokens();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private endpoint(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  /**
   * Sends one prompt and returns the model's text.
   *
   * Always throws `AiCategoryProviderError` on failure, so the pool classifies
   * a local failure exactly as it classifies a Gemini one and simply runs out
   * of providers. No ledger slot is taken anywhere in here: a local model draws
   * on no external allowance, and charging it against Google's would make the
   * quota counter lie.
   */
  private async request(
    prompt: string,
    options: AiCategoryAnalyzeOptions,
    label: string,
  ): Promise<string> {
    const budgetMs = options.budgetMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, budgetMs));
    const startedAt = Date.now();

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_tokens: this.maxTokens,
          messages: [{ role: "user", content: `${NO_THINK}\n\n${prompt}` }],
        }),
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        // The body is the local server's own error; it carries no credentials,
        // but it is still truncated so a stray prompt echo cannot fill the log.
        const body = await response.text().catch(() => "");
        logger.warn("local_ai.request_failed", {
          provider: this.name,
          model: this.model,
          label,
          status: response.status,
          statusText: response.statusText,
          body: body.slice(0, 300),
          durationMs,
        });
        throw new AiCategoryProviderError(
          `Local AI request failed (${response.status} ${response.statusText})`,
          { provider: this.name, status: response.status },
        );
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        logger.warn("local_ai.empty_reply", {
          provider: this.name,
          model: this.model,
          label,
          durationMs,
        });
        throw new AiCategoryProviderError("Local AI returned an empty reply", {
          provider: this.name,
        });
      }

      logger.info("local_ai.request_ok", {
        provider: this.name,
        model: this.model,
        label,
        replyChars: content.length,
        durationMs,
      });
      return stripJsonFence(content);
    } catch (error) {
      if (error instanceof AiCategoryProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("local_ai.request_error", {
        provider: this.name,
        model: this.model,
        label,
        error: message,
        durationMs: Date.now() - startedAt,
      });
      throw new AiCategoryProviderError(`Local AI request error: ${message}`, {
        provider: this.name,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async analyze(
    request: AiCategoryRequest,
    options: AiCategoryAnalyzeOptions = {},
  ): Promise<AiCategoryResult> {
    const text = await this.request(buildAiCategoryPrompt(request), options, "analyze");
    const result = parseAiCategoryResult(text);
    logger.info("local_ai.analyze_parsed", {
      provider: this.name,
      categories: result.categories.length,
      hashtags: result.hashtags.length,
    });
    return result;
  }

  /**
   * Analyzes several shops in one call, under the same contract Gemini keeps:
   * every submitted handle comes back exactly once, in results or in skipped.
   * An invalid reply throws rather than being partly applied.
   */
  async analyzeBatch(
    items: readonly AiBatchItem[],
    options: AiCategoryAnalyzeOptions = {},
  ): Promise<AiBatchResult> {
    const handles = items.map((i) => i.handle);
    const text = await this.request(buildAiBatchPrompt(items), options, "batch");
    const batch = parseAiBatchResult(text, handles);
    logger.info("local_ai.batch_parsed", {
      provider: this.name,
      size: items.length,
      results: batch.results.size,
      skipped: batch.skipped.length,
    });
    return batch;
  }
}

/** Attempts one local call gets. Exported so tests can state the contract. */
export const LOCAL_AI_MAX_ATTEMPTS = MAX_ATTEMPTS;
