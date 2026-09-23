import {
  formatHashtagWhitelist,
  MAX_TELEGRAM_HASHTAGS,
  sanitizeHashtags,
} from "@/config/telegram-hashtags";
import type { DetectedCategory, ProductCategory } from "@/types/category";
import type { BoutiqueEnrichment } from "@/types/enrichment";
import type { InstagramBusinessAddress, InstagramExternalLink } from "@/types/instagram";

/**
 * AI category stage — provider abstraction.
 *
 * This file defines the seam for an LLM-backed category analyzer (Gemini today;
 * OpenAI/Claude later). It does NOT call any model itself. A concrete provider
 * implements `AiCategoryProvider.analyze`, typically by feeding
 * `buildAiCategoryPrompt` to a model and passing the reply through
 * `parseAiCategoryResult`.
 *
 * Hard rules, enforced in code (never trust the model):
 *  - the AI may ONLY choose from the allowed internal categories — invented ids
 *    are dropped in the pipeline;
 *  - a suggestion below the confidence threshold is ignored.
 *
 * The keyword engine runs FIRST and is passed to the AI as context: the AI
 * validates/extends it, it never replaces it.
 */

/** Minimum confidence (0–100) for an AI suggestion to count. */
export const AI_CONFIDENCE_THRESHOLD = 60;

/** Everything the AI stage is given (text only — never images). */
export interface AiCategoryRequest {
  businessName: string | null;
  username: string | null;
  biography: string | null;
  externalUrl: string | null;
  externalUrls: InstagramExternalLink[];
  businessAddress: InstagramBusinessAddress | null;
  captions: string[];
  hashtags: string[];
  mentions: string[];
  /** The ONLY categories the AI may choose from. */
  allowedCategories: ProductCategory[];
  /**
   * The ONLY Telegram hashtags the AI may choose from (canonical strings,
   * "#" included). Omitted → the AI is not asked for hashtags at all.
   */
  allowedHashtags?: readonly string[];
  /** Keyword-engine results, given as strong prior context (validate/extend). */
  keywordResults?: DetectedCategory[];
  /** Structured enrichment already derived from the same data. */
  enrichment?: BoutiqueEnrichment;
}

/** One AI-suggested category. `id` must be one of the allowed category ids. */
export interface AiCategorySuggestion {
  id: string;
  /** 0–100. */
  confidence: number;
  reason: string;
}

/** Strict shape the AI must return (also the parsed/validated result). */
export interface AiCategoryResult {
  categories: AiCategorySuggestion[];
  /**
   * Telegram hashtags chosen from the whitelist — a structured field of its own,
   * independent of `categories`. Already validated against the whitelist,
   * deduplicated and capped, so it is safe to render verbatim.
   */
  hashtags: string[];
  city: string | null;
  mall: string | null;
  address: string | null;
  targetAudience: string | null;
  priceSegment: string | null;
  style: string | null;
  summary: string | null;
}

export const EMPTY_AI_RESULT: AiCategoryResult = {
  categories: [],
  hashtags: [],
  city: null,
  mall: null,
  address: null,
  targetAudience: null,
  priceSegment: null,
  style: null,
  summary: null,
};

/**
 * The pluggable seam. Implement this with Gemini/OpenAI/Claude and wire it via a
 * server-only resolver — nothing in the pipeline changes.
 */
export interface AiCategoryAnalyzeOptions {
  /**
   * Wall-clock budget for this ONE call, overriding the provider's own default.
   * A pool that may try several providers inside a single request uses it to
   * hand each one only the time that is actually left, so a project that fails
   * fast leaves its unused time to the next one.
   */
  budgetMs?: number;
}

export interface AiCategoryProvider {
  readonly name: string;
  analyze(
    request: AiCategoryRequest,
    options?: AiCategoryAnalyzeOptions,
  ): Promise<AiCategoryResult>;
}

/**
 * Raised when a real AI provider fails terminally (transport error, timeout, or
 * a non-recoverable API status after retries). Providers degrade GRACEFULLY by
 * default — `analyze()` returns an empty result so a flaky model never crashes
 * an import. A caller that needs to treat a failure as a retryable error (e.g.
 * the queue's independent Analyze stage) opts into throwing instead; this type
 * lets it distinguish a real outage from a genuinely empty result.
 */
export class AiCategoryProviderError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(message: string, options: { provider: string; status?: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiCategoryProviderError";
    this.provider = options.provider;
    this.status = options.status;
  }
}

/** Default provider: no model connected, so it contributes nothing. */
export const disabledAiCategoryProvider: AiCategoryProvider = {
  name: "disabled",
  async analyze() {
    return { ...EMPTY_AI_RESULT };
  },
};

/**
 * Pure default resolver — always the disabled provider. The real, env-gated
 * resolver lives in the server-only provider module (it may construct a model
 * client), and falls back to this when no API key is configured.
 */
export function getAiCategoryProvider(): AiCategoryProvider {
  return disabledAiCategoryProvider;
}

/**
 * Builds the instruction text a concrete provider sends to its model. Lists the
 * allowed categories, the keyword-engine results (as prior context), the
 * enrichment, the strict JSON schema, and the hard rules.
 */
export function buildAiCategoryPrompt(request: AiCategoryRequest): string {
  const allowed = request.allowedCategories.map((c) => `- ${c.id} (${c.label})`).join("\n");
  const keyword =
    request.keywordResults && request.keywordResults.length > 0
      ? request.keywordResults.map((k) => `- ${k.id} (score ${k.score})`).join("\n")
      : "(none)";
  const data = JSON.stringify(
    {
      businessName: request.businessName,
      username: request.username,
      biography: request.biography,
      website: request.externalUrl,
      externalLinks: request.externalUrls,
      businessAddress: request.businessAddress,
      captions: request.captions,
      hashtags: request.hashtags,
      mentions: request.mentions,
      enrichment: request.enrichment ?? null,
    },
    null,
    2,
  );

  // Hashtags are optional: when no whitelist is supplied the model is not asked
  // for them at all, and the schema stays exactly as it was before.
  const allowedHashtags = request.allowedHashtags ?? [];
  const wantsHashtags = allowedHashtags.length > 0;
  const max = MAX_TELEGRAM_HASHTAGS;
  const hashtagSchema = wantsHashtags ? ',"hashtags":["#Tag","..."]' : "";
  const hashtagRules = wantsHashtags
    ? [
        'Also select Telegram "hashtags" for this boutique. This is a SEPARATE field from "categories" — it describes how the boutique is advertised, not its internal classification.',
        "Choose hashtags ONLY from the allowed hashtag list below, copied CHARACTER FOR CHARACTER (including the leading # and the exact letter case). NEVER invent, translate, pluralize, or combine hashtags.",
        `Return 2 to ${max} hashtags, and never more than ${max}. Pick only hashtags genuinely supported by the profile and posts — do NOT pad the list to reach ${max}, and do NOT add every hashtag that could conceivably apply.`,
        "When a broad allowed hashtag already covers the idea, reuse it rather than inventing a narrower one (e.g. #Обувь for a shoe shop, adding #Кроссовки only when sneakers are specifically its focus).",
        "COMBINE ONE audience tag with ONE OR TWO garment tags — that is normally the whole set: womenswear jeans is #Женскаяодежда #Джинсы, menswear T-shirts is #Мужскаяодежда #Футболки, unisex hoodies is #Унисексодежда #Худи, women\'s sportswear is #Женскаяодежда #Спортивнаяодежда, and a winter men\'s jacket shop is #Мужскаяодежда #Куртки #Зимняяодежда. Two or three tags is the norm; reach for more only when the shop genuinely sells across several ranges.",
        "NEVER repeat the same idea at two levels of detail. The audience tag already says who it is for, so do not follow it with a garment tag that repeats the audience, and do not pick a narrower tag when a broader one you already chose covers it.",
        "Use an audience, seasonal or unisex tag ONLY when the profile actually says so. A coat in a photo is not evidence of #Зимняяодежда, and gender simply not being mentioned is not #Унисексодежда — use the plain garment tag alone whenever the profile does not state it.",
        'Return an empty "hashtags" array when the content supports none of them.',
      ]
    : [];
  const hashtagSection = wantsHashtags
    ? [
        "Allowed hashtags (copy exactly; these are the ONLY permitted values):",
        formatHashtagWhitelist(allowedHashtags),
        "",
      ]
    : [];

  return [
    "You analyze an Instagram clothing/retail business and profile it.",
    "TASK — treat this Instagram account as a PRODUCT CATALOG, not a business classifier. Categories are MULTI-LABEL. Read the profile name, bio, hashtags and ALL post captions TOGETHER as one catalog (not post by post). Return EVERY product category the business sells: if a category is clearly present in even ONE post, include it. Multiple categories are expected — if one post advertises jeans, another shoes, another jackets and another T-shirts, return all four. Do NOT collapse to just the most common category, and do NOT return only the dominant or most frequent categories. Include a category even if it appears in only one post. Omit a category ONLY when there is no evidence for it in ANY of the posts.",
    "Choose category ids ONLY from the allowed list below. Never invent a category id.",
    `Confidence (0-100) is your CERTAINTY that the business sells that category — NOT how frequently it appears. A single clear post is enough to be highly confident. Include a category only when confidence is ${AI_CONFIDENCE_THRESHOLD} or higher; a clearly-present category must be at least ${AI_CONFIDENCE_THRESHOLD} even if it shows up in just one post (use values below ${AI_CONFIDENCE_THRESHOLD} only when you are genuinely unsure whether they sell it). If no category has any evidence at all, return an empty "categories" array.`,
    "Sort the categories array by confidence, highest first.",
    "The keyword engine already ran; treat its results as strong prior signals. Validate or EXTEND them — never discard a clearly-correct keyword result, and add any other categories the posts reveal.",
    ...hashtagRules,
    "Respond with STRICT JSON only. No markdown, no code fences, no commentary, no extra fields. Match EXACTLY this schema:",
    `{"categories":[{"id":"<allowed id>","confidence":0-100,"reason":"..."}]${hashtagSchema},"city":"...","mall":"...","address":"...","targetAudience":"...","priceSegment":"...","style":"...","summary":"..."}`,
    "Use null (not empty string) for city, mall, address, targetAudience, priceSegment, style or summary when unknown.",
    "",
    "Allowed categories:",
    allowed,
    "",
    ...hashtagSection,
    "Keyword engine results (prior context):",
    keyword,
    "",
    "Business data (text only):",
    data,
  ].join("\n");
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Safely parses a model reply (JSON string or already-parsed object) into a
 * well-formed `AiCategoryResult`. Never throws — malformed input yields an empty
 * result, malformed category entries are dropped, extra fields are ignored. Does
 * NOT apply the allowed-id / confidence rules (the pipeline enforces those);
 * hashtags ARE whitelist-checked here, since they are published verbatim.
 */
export function parseAiCategoryResult(raw: unknown): AiCategoryResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...EMPTY_AI_RESULT };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...EMPTY_AI_RESULT };
  }

  const obj = parsed as Record<string, unknown>;
  const rawCategories = Array.isArray(obj.categories) ? obj.categories : [];
  const categories: AiCategorySuggestion[] = [];
  for (const entry of rawCategories) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const confidence =
      typeof e.confidence === "number" && Number.isFinite(e.confidence) ? e.confidence : NaN;
    if (!id || Number.isNaN(confidence)) continue;
    categories.push({
      id,
      confidence: Math.max(0, Math.min(100, confidence)),
      reason: typeof e.reason === "string" ? e.reason : "",
    });
  }

  return {
    categories,
    // Unlike category ids, hashtags are validated HERE: they are rendered
    // verbatim into a public channel, so no unvetted string may survive the
    // parser, whoever the caller is.
    hashtags: sanitizeHashtags(obj.hashtags),
    city: toStringOrNull(obj.city),
    mall: toStringOrNull(obj.mall),
    address: toStringOrNull(obj.address),
    targetAudience: toStringOrNull(obj.targetAudience),
    priceSegment: toStringOrNull(obj.priceSegment),
    style: toStringOrNull(obj.style),
    summary: toStringOrNull(obj.summary),
  };
}
