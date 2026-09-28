import "server-only";

import { localAiBaseUrl, localAiMaxTokens, localAiModel, localAiTimeoutMs } from "@/config/limits";
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

/**
 * Worked examples, shown to the local model only.
 *
 * These exist because a small model gets three specific things wrong that a
 * hosted one does not, and all three are matters of STYLE rather than rules —
 * so no amount of extra rule prose fixes them, but seeing correct answers does:
 *
 *   1. It marks every category 100. Real confidence is a judgement, and the
 *      pipeline drops anything under 60, so a flat 100 throws away the only
 *      signal the field carries.
 *   2. It writes English summaries from Russian shops, because its instruction
 *      tuning leans English.
 *   3. It omits the audience tag even when the bio states it outright.
 *
 * Deliberately short: four examples covering audience (stated three ways and
 * NOT stated), a spread of confidence, and a Russian summary written from an
 * English source. Every id and tag below is from the project's own taxonomy —
 * nothing here invents a category or a hashtag.
 *
 * This is appended by the LOCAL provider only. The shared prompt is untouched,
 * so Gemini's behaviour — and production — is exactly as it was.
 */
const FEW_SHOT = [
  "WORKED EXAMPLES — study these, then answer for the real data below in the same style.",
  "Each example shows the object for ONE shop. When several shops are requested, this same object goes under that shop's handle inside \"results\".",
  "",
  'Example A — bio: "Женская одежда. Худи и футболки. Иногда бывают джинсы."',
  '{"categories":[{"id":"hudi","confidence":95,"reason":"Худи названы прямо в описании."},{"id":"futbolki","confidence":95,"reason":"Футболки названы прямо в описании."},{"id":"dzhinsy","confidence":70,"reason":"Джинсы упомянуты как нерегулярный товар."}],"hashtags":["#Женскаяодежда","#Худи","#Футболки"],"city":null,"mall":null,"address":null,"targetAudience":"Женщины","priceSegment":null,"style":null,"summary":"Магазин женской одежды: худи, футболки, иногда джинсы."}',
  "",
  'Example B — bio: "Мужская одежда. Худи и футболки."',
  '{"categories":[{"id":"hudi","confidence":95,"reason":"Худи названы прямо в описании."},{"id":"futbolki","confidence":95,"reason":"Футболки названы прямо в описании."}],"hashtags":["#Мужскаяодежда","#Худи","#Футболки"],"city":null,"mall":null,"address":null,"targetAudience":"Мужчины","priceSegment":null,"style":null,"summary":"Магазин мужской одежды: худи и футболки."}',
  "",
  'Example C — bio in English: "Unisex streetwear. Hoodies and t-shirts. New drop every week."',
  '{"categories":[{"id":"hudi","confidence":95,"reason":"Hoodies названы прямо в описании."},{"id":"futbolki","confidence":95,"reason":"T-shirts названы прямо в описании."}],"hashtags":["#Унисексодежда","#Худи","#Футболки"],"city":null,"mall":null,"address":null,"targetAudience":"Унисекс","priceSegment":null,"style":"Streetwear","summary":"Унисекс-бренд уличной одежды: худи и футболки, регулярные новинки."}',
  "Note on C: the profile is written in English, but the summary, targetAudience and reasons are STILL Russian. Always write them in Russian.",
  "",
  'Example D — bio: "Худи и футболки. Доставка по Алматы." (audience NOT stated)',
  '{"categories":[{"id":"hudi","confidence":95,"reason":"Худи названы прямо в описании."},{"id":"futbolki","confidence":95,"reason":"Футболки названы прямо в описании."}],"hashtags":["#Худи","#Футболки"],"city":"Алматы","mall":null,"address":null,"targetAudience":null,"priceSegment":null,"style":null,"summary":"Магазин худи и футболок с доставкой по Алматы."}',
  "Note on D: no audience tag, because the profile never says who it is for. Never guess a gender.",
  "",
  "What these examples demonstrate:",
  "- Confidence is a JUDGEMENT, not a formality: something stated outright is 90-100, something mentioned once or in passing is 65-85. Do not mark everything 100.",
  '- The audience tag follows what the profile SAYS: #Женскаяодежда, #Мужскаяодежда or #Унисексодежда when stated, and NO audience tag at all when it is not.',
  '- "summary", "targetAudience", "priceSegment", "style" and every "reason" are written in RUSSIAN, whatever language the profile is in.',
].join("\n");

/**
 * Caps on the variable part of a local prompt.
 *
 * The taxonomy — every category and every allowed hashtag — is a fixed cost in
 * every prompt. What is NOT fixed is the profile: captions are sent for all
 * twenty scraped posts with no ceiling anywhere, so a shop that writes long
 * posts builds a prompt twice the size of a shop that writes short ones. Three
 * of five real profiles measured at 20-23k characters, past what an 8k window
 * can hold however small the batch, and raising the window only moves the wall.
 *
 * Trimming here rather than in the shared builder keeps Gemini's prompt exactly
 * as it was — it has context to spare and no reason to see less.
 *
 * Ten captions is not a guess at "enough text": the categorical signal lives in
 * the bio and the hashtags, which are kept whole, and a shop's twentieth post
 * advertises much the same goods as its tenth. What the cap removes is
 * repetition, not evidence.
 */
const MAX_CAPTIONS = 10;
const MAX_CAPTION_CHARS = 400;
const MAX_HASHTAGS = 40;
const MAX_MENTIONS = 20;

/** Cuts at a word boundary where it can, so a caption does not end mid-word. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Bounds one request so the prompt built from it fits a local context window.
 *
 * Returns the SAME object when nothing needed trimming, so the common case
 * carries no cost and the logs stay quiet about profiles that were already
 * small enough.
 */
function trimForLocalContext(request: AiCategoryRequest): AiCategoryRequest {
  const tooManyCaptions = request.captions.length > MAX_CAPTIONS;
  const longCaption = request.captions.some((c) => c.length > MAX_CAPTION_CHARS);
  const tooManyTags = request.hashtags.length > MAX_HASHTAGS;
  const tooManyMentions = request.mentions.length > MAX_MENTIONS;
  if (!tooManyCaptions && !longCaption && !tooManyTags && !tooManyMentions) return request;

  return {
    ...request,
    captions: request.captions.slice(0, MAX_CAPTIONS).map((c) => clip(c, MAX_CAPTION_CHARS)),
    hashtags: request.hashtags.slice(0, MAX_HASHTAGS),
    mentions: request.mentions.slice(0, MAX_MENTIONS),
  };
}

/** Local models have no shared load to wait out, so one attempt is the honest number. */
const MAX_ATTEMPTS = 1;

/**
 * The one human-readable sentence out of a local server's error body.
 *
 * LM Studio answers `{"error":"..."}`; anything else is passed through as
 * plain text. Bounded, because the body may echo part of the prompt.
 */
function explainBody(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "string") return err.slice(0, 200);
      if (err && typeof err === "object") {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string") return msg.slice(0, 200);
      }
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.slice(0, 200);
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
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
    this.timeoutMs = options.timeoutMs ?? localAiTimeoutMs();
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
          // Order matters: the worked examples set the style, then the shared
          // prompt's rules and the real data come LAST, immediately before the
          // answer. The shared prompt itself is never modified.
          messages: [{ role: "user", content: `${NO_THINK}\n\n${FEW_SHOT}\n\n${prompt}` }],
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
        // Carry the server's own sentence into the error. Without it the queue
        // shows "400 Bad Request" and the actual cause — almost always "the
        // prompt is longer than the context length" — stays buried in a log the
        // person looking at the failed row is not reading.
        throw new AiCategoryProviderError(
          `Local AI request failed (${response.status} ${response.statusText})` +
            (explainBody(body) ? `: ${explainBody(body)}` : ""),
          { provider: this.name, status: response.status },
        );
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";

      /**
       * A reply the model was cut off mid-sentence is not a reply.
       *
       * This has to be checked rather than parsed, because the failure is
       * SILENT otherwise: `parseAiCategoryResult` answers unparseable text with
       * an empty result, so a truncated JSON object becomes a shop analyzed
       * "successfully" with no categories, no hashtags and no summary — written
       * to the database and stamped as done. An 8B model that falls into
       * repeating itself does exactly this, so the guard is not theoretical.
       */
      if (choice?.finish_reason === "length") {
        logger.warn("local_ai.truncated", {
          provider: this.name,
          model: this.model,
          label,
          maxTokens: this.maxTokens,
          replyChars: content.length,
          durationMs,
        });
        throw new AiCategoryProviderError(
          `Local AI reply was cut off at max_tokens (${this.maxTokens}). ` +
            "Raise LOCAL_AI_MAX_TOKENS, or load the model with a larger context length.",
          { provider: this.name },
        );
      }

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
    const trimmed = trimForLocalContext(request);
    if (trimmed !== request) {
      logger.info("local_ai.request_trimmed", {
        provider: this.name,
        handle: request.username,
        captions: `${request.captions.length} → ${trimmed.captions.length}`,
        hashtags: `${request.hashtags.length} → ${trimmed.hashtags.length}`,
      });
    }
    const text = await this.request(buildAiCategoryPrompt(trimmed), options, "analyze");
    const result = parseAiCategoryResult(text);

    /**
     * A reply that parsed to NOTHING is a failure, not an empty answer.
     *
     * `parseAiCategoryResult` answers text it cannot read with an empty result,
     * which is the right call for a hosted model that occasionally omits a
     * field — but a small local one sometimes returns hundreds of tokens of
     * prose instead of JSON, and that came back as a shop analyzed
     * "successfully" with no categories, no hashtags and no summary, stamped
     * done and stored. A real answer always carries at least one of the three;
     * nothing at all means the reply was never usable, and the item should stay
     * retryable instead of being quietly written off.
     */
    const empty =
      result.categories.length === 0 && result.hashtags.length === 0 && !result.summary;
    if (empty && text.trim()) {
      logger.warn("local_ai.unparsed_reply", {
        provider: this.name,
        model: this.model,
        handle: request.username,
        replyChars: text.length,
        preview: text.slice(0, 200),
      });
      throw new AiCategoryProviderError(
        "Local AI returned a reply that carried no usable analysis — it did not answer in JSON.",
        { provider: this.name },
      );
    }

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
    const trimmed = items.map((item) => {
      const request = trimForLocalContext(item.request);
      return request === item.request ? item : { ...item, request };
    });
    const trimmedCount = trimmed.filter((item, i) => item !== items[i]).length;
    if (trimmedCount > 0) {
      logger.info("local_ai.request_trimmed", {
        provider: this.name,
        label: "batch",
        trimmed: `${trimmedCount}/${items.length}`,
      });
    }

    const text = await this.request(buildAiBatchPrompt(trimmed), options, "batch");
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
