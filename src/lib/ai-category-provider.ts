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

/** Which rate limit a 429 hit — they demand opposite responses. */
export type QuotaScope = "per-minute" | "per-day";

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
  /**
   * Which allowance a 429 exhausted, when the provider said so. The two are
   * nothing alike: "per-minute" clears in seconds, "per-day" is gone until the
   * quota resets. Undefined when the provider did not say, or the failure was
   * not a rate limit.
   */
  readonly quotaScope?: QuotaScope;

  constructor(
    message: string,
    options: { provider: string; status?: number; cause?: unknown; quotaScope?: QuotaScope },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiCategoryProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.quotaScope = options.quotaScope;
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
    ? hashtagRuleLines(max)
    : [];
  const hashtagSection = wantsHashtags
    ? ["Allowed hashtags (copy exactly; these are the ONLY permitted values):", formatHashtagWhitelist(allowedHashtags), ""]
    : [];

  return [
    ROLE_LINE,
    ...categoryRuleLines(),
    ...hashtagRules,
    "Respond with STRICT JSON only. No markdown, no code fences, no commentary, no extra fields. Match EXACTLY this schema:",
    `{${SHOP_OBJECT_SCHEMA(hashtagSchema)}}`,
    NULL_RULE,
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

/** Opening line — identical for one shop or many. */
const ROLE_LINE = "You analyze an Instagram clothing/retail business and profile it.";

const NULL_RULE =
  "Use null (not empty string) for city, mall, address, targetAudience, priceSegment, style or summary when unknown.";

/** The per-shop JSON shape, shared by the single and batch schemas. */
const SHOP_OBJECT_SCHEMA = (hashtagSchema: string) =>
  `"categories":[{"id":"<allowed id>","confidence":0-100,"reason":"..."}]${hashtagSchema},"city":"...","mall":"...","address":"...","targetAudience":"...","priceSegment":"...","style":"...","summary":"..."`;

/**
 * The category rules, in one place.
 *
 * Both prompts read from here rather than each carrying its own copy, because
 * the batch prompt exists to save requests — not to quietly analyze shops by
 * different rules than the single prompt does.
 */
function categoryRuleLines(): string[] {
  return [
    "TASK — treat this Instagram account as a PRODUCT CATALOG, not a business classifier. Categories are MULTI-LABEL. Read the profile name, bio, hashtags and ALL post captions TOGETHER as one catalog (not post by post). Return EVERY product category the business sells: if a category is clearly present in even ONE post, include it. Multiple categories are expected — if one post advertises jeans, another shoes, another jackets and another T-shirts, return all four. Do NOT collapse to just the most common category, and do NOT return only the dominant or most frequent categories. Include a category even if it appears in only one post. Omit a category ONLY when there is no evidence for it in ANY of the posts.",
    "Choose category ids ONLY from the allowed list below. Never invent a category id.",
    `Confidence (0-100) is your CERTAINTY that the business sells that category — NOT how frequently it appears. A single clear post is enough to be highly confident. Include a category only when confidence is ${AI_CONFIDENCE_THRESHOLD} or higher; a clearly-present category must be at least ${AI_CONFIDENCE_THRESHOLD} even if it shows up in just one post (use values below ${AI_CONFIDENCE_THRESHOLD} only when you are genuinely unsure whether they sell it). If no category has any evidence at all, return an empty "categories" array.`,
    "Sort the categories array by confidence, highest first.",
    "The keyword engine already ran; treat its results as strong prior signals. Validate or EXTEND them — never discard a clearly-correct keyword result, and add any other categories the posts reveal.",
  ];
}

/** The hashtag rules, in one place — see {@link categoryRuleLines}. */
function hashtagRuleLines(max: number): string[] {
  return [
        'Also select Telegram "hashtags" for this boutique. This is a SEPARATE field from "categories" — it describes how the boutique is advertised, not its internal classification.',
        "Choose hashtags ONLY from the allowed hashtag list below, copied CHARACTER FOR CHARACTER (including the leading # and the exact letter case). NEVER invent, translate, pluralize, or combine hashtags.",
        `Return 2 to ${max} hashtags, and never more than ${max}. Pick only hashtags genuinely supported by the profile and posts — do NOT pad the list to reach ${max}, and do NOT add every hashtag that could conceivably apply.`,
        "When a broad allowed hashtag already covers the idea, reuse it rather than inventing a narrower one (e.g. #Обувь for a shoe shop, adding #Кроссовки only when sneakers are specifically its focus).",
        "COMBINE ONE audience tag with ONE OR TWO garment tags — that is normally the whole set: womenswear jeans is #Женскаяодежда #Джинсы, menswear T-shirts is #Мужскаяодежда #Футболки, unisex hoodies is #Унисексодежда #Худи, women\'s sportswear is #Женскаяодежда #Спортивнаяодежда, and a winter men\'s jacket shop is #Мужскаяодежда #Куртки #Зимняяодежда. Two or three tags is the norm; reach for more only when the shop genuinely sells across several ranges.",
        "NEVER repeat the same idea at two levels of detail. The audience tag already says who it is for, so do not follow it with a garment tag that repeats the audience, and do not pick a narrower tag when a broader one you already chose covers it.",
        "Use an audience, seasonal or unisex tag ONLY when the profile actually says so. A coat in a photo is not evidence of #Зимняяодежда, and gender simply not being mentioned is not #Унисексодежда — use the plain garment tag alone whenever the profile does not state it.",
    'Return an empty "hashtags" array when the content supports none of them.',
  ];
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

// ---------------------------------------------------------------------------
// Batch analysis
//
// Several shops in ONE model call. The point is the request count: a provider's
// daily allowance is spent per REQUEST, so three shops answered together cost a
// third of what three separate calls cost. Nothing else changes — the rules,
// the allowed ids and the allowed hashtags are the very same ones the single
// prompt uses, because a batch must not quietly classify shops by other rules.

/** One shop inside a batch, paired with the handle its result must come back under. */
export interface AiBatchItem {
  handle: string;
  request: AiCategoryRequest;
}

/** A shop the model declined to classify, and why. Not a failure — a decision. */
export interface AiBatchSkip {
  handle: string;
  reason: string;
}

export interface AiBatchResult {
  /** Keyed by the handle exactly as it was submitted. */
  results: Map<string, AiCategoryResult>;
  skipped: AiBatchSkip[];
}

/**
 * Raised when a batch reply cannot be trusted as a whole.
 *
 * A batch is all-or-nothing on VALIDITY: if one shop is missing, duplicated or
 * unknown, the reply says nothing reliable about which answer belongs to which
 * shop, and writing any of it risks attributing one boutique's categories to
 * another. Far better to fail the batch and retry than to persist a plausible
 * mix-up that nobody would ever notice.
 */
export class AiBatchValidationError extends Error {
  constructor(message: string) {
    super(`AI batch reply is invalid: ${message}`);
    this.name = "AiBatchValidationError";
  }
}

/** The per-shop payload the model reads — same fields the single prompt sends. */
function batchShopPayload(item: AiBatchItem): Record<string, unknown> {
  const r = item.request;
  return {
    handle: item.handle,
    keywordEngineResults: (r.keywordResults ?? []).map((k) => ({ id: k.id, score: k.score })),
    businessName: r.businessName,
    username: r.username,
    biography: r.biography,
    website: r.externalUrl,
    externalLinks: r.externalUrls,
    businessAddress: r.businessAddress,
    captions: r.captions,
    hashtags: r.hashtags,
    mentions: r.mentions,
    enrichment: r.enrichment ?? null,
  };
}

/**
 * Builds ONE prompt covering several shops.
 *
 * The allowed categories and hashtags are read from the first item: every item
 * in a batch is built from the same configuration, so they are identical by
 * construction, and sending them once per shop would waste most of the prompt.
 */
export function buildAiBatchPrompt(items: readonly AiBatchItem[]): string {
  if (items.length === 0) throw new AiBatchValidationError("a batch needs at least one shop");

  const first = items[0]!.request;
  const allowed = first.allowedCategories.map((c) => `- ${c.id} (${c.label})`).join("\n");
  const allowedHashtags = first.allowedHashtags ?? [];
  const wantsHashtags = allowedHashtags.length > 0;
  const hashtagSchema = wantsHashtags ? ',"hashtags":["#Tag","..."]' : "";
  const handles = items.map((i) => i.handle);

  return [
    ROLE_LINE,
    `You are given ${items.length} shops in one request. Analyze EACH shop INDEPENDENTLY, using only that shop's own data. Never let one shop's products, city or style influence another's — they are unrelated businesses that happen to be sent together.`,
    ...categoryRuleLines(),
    ...(wantsHashtags ? hashtagRuleLines(MAX_TELEGRAM_HASHTAGS) : []),
    "",
    "BATCH RULES — these decide whether the whole reply is usable:",
    `- Every handle listed below must appear EXACTLY ONCE: either as a key in "results" or as an entry in "skipped". Never both, never neither.`,
    "- Use the handle string exactly as given. Do not add an @, change its case, or invent handles.",
    `- If a shop's data is too thin, unclear or not a clothing business, put it in "skipped" with a short reason instead of guessing. A skip is a normal outcome, not an error.`,
    "- One skipped shop must NOT affect the others: analyze every shop you can.",
    "",
    "Respond with STRICT JSON only. No markdown, no code fences, no commentary, no extra fields. Match EXACTLY this schema:",
    `{"results":{"<handle>":{${SHOP_OBJECT_SCHEMA(hashtagSchema)}}},"skipped":[{"handle":"<handle>","reason":"..."}]}`,
    NULL_RULE,
    `Return "skipped": [] when you classified every shop.`,
    "",
    "Handles in this batch (each must appear exactly once in the reply):",
    handles.map((h) => `- ${h}`).join("\n"),
    "",
    "Allowed categories:",
    allowed,
    "",
    ...(wantsHashtags
      ? [
          "Allowed hashtags (copy exactly; these are the ONLY permitted values):",
          formatHashtagWhitelist(allowedHashtags),
          "",
        ]
      : []),
    "Shops (text only):",
    JSON.stringify(items.map(batchShopPayload), null, 2),
  ].join("\n");
}

/**
 * Validates a batch reply against the handles that were actually sent, and
 * converts it. Throws {@link AiBatchValidationError} on anything that would make
 * the mapping ambiguous — see the class comment for why that is worth failing.
 *
 * Handle matching ignores case and a leading "@": the model occasionally echoes
 * a handle prettified, and rejecting a whole batch over "@Qoima" vs "qoima"
 * would spend a request to punish a cosmetic difference.
 */
export function parseAiBatchResult(raw: unknown, expected: readonly string[]): AiBatchResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AiBatchValidationError("reply is not valid JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiBatchValidationError("reply is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const rawResults = obj.results;
  const rawSkipped = obj.skipped ?? [];
  if (!rawResults || typeof rawResults !== "object" || Array.isArray(rawResults)) {
    throw new AiBatchValidationError('"results" is missing or not an object');
  }
  if (!Array.isArray(rawSkipped)) {
    throw new AiBatchValidationError('"skipped" is not an array');
  }

  const key = (h: string) => h.trim().replace(/^@/, "").toLocaleLowerCase("en-US");
  const canonical = new Map(expected.map((h) => [key(h), h]));
  const seen = new Map<string, "result" | "skipped">();

  const results = new Map<string, AiCategoryResult>();
  for (const [handle, value] of Object.entries(rawResults as Record<string, unknown>)) {
    const real = canonical.get(key(handle));
    if (!real) throw new AiBatchValidationError(`unknown handle in results: ${handle}`);
    if (seen.has(key(handle))) {
      throw new AiBatchValidationError(`handle appears more than once: ${real}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AiBatchValidationError(`result for ${real} is not an object`);
    }
    seen.set(key(handle), "result");
    results.set(real, parseAiCategoryResult(value));
  }

  const skipped: AiBatchSkip[] = [];
  for (const entry of rawSkipped) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AiBatchValidationError("a skipped entry is not an object");
    }
    const e = entry as Record<string, unknown>;
    const handle = typeof e.handle === "string" ? e.handle : "";
    const real = canonical.get(key(handle));
    if (!real) throw new AiBatchValidationError(`unknown handle in skipped: ${handle || "(missing)"}`);
    const already = seen.get(key(handle));
    if (already === "result") {
      throw new AiBatchValidationError(`${real} appears in BOTH results and skipped`);
    }
    if (already === "skipped") {
      throw new AiBatchValidationError(`handle appears more than once in skipped: ${real}`);
    }
    seen.set(key(handle), "skipped");
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : "no reason given";
    skipped.push({ handle: real, reason });
  }

  const missing = expected.filter((h) => !seen.has(key(h)));
  if (missing.length > 0) {
    throw new AiBatchValidationError(`no answer for: ${missing.join(", ")}`);
  }

  return { results, skipped };
}
