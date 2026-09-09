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
export interface AiCategoryProvider {
  readonly name: string;
  analyze(request: AiCategoryRequest): Promise<AiCategoryResult>;
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

  return [
    "You classify an Instagram clothing/retail business into product categories and profile it.",
    "Choose category ids ONLY from the allowed list below. Never invent a category id.",
    `Include a category ONLY if your confidence is ${AI_CONFIDENCE_THRESHOLD} or higher (scale 0-100). If none qualify, return an empty "categories" array.`,
    "The keyword engine already ran; treat its results as strong prior signals. Validate or EXTEND them — do not classify from scratch and do not discard a clearly-correct keyword result.",
    "Respond with STRICT JSON only. No markdown, no code fences, no commentary, no extra fields. Match EXACTLY this schema:",
    '{"categories":[{"id":"<allowed id>","confidence":0-100,"reason":"..."}],"city":"...","mall":"...","address":"...","targetAudience":"...","priceSegment":"...","style":"...","summary":"..."}',
    "Use null (not empty string) for city, mall, address, targetAudience, priceSegment, style or summary when unknown.",
    "",
    "Allowed categories:",
    allowed,
    "",
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
 * NOT apply the allowed-id / confidence rules (the pipeline enforces those).
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
    city: toStringOrNull(obj.city),
    mall: toStringOrNull(obj.mall),
    address: toStringOrNull(obj.address),
    targetAudience: toStringOrNull(obj.targetAudience),
    priceSegment: toStringOrNull(obj.priceSegment),
    style: toStringOrNull(obj.style),
    summary: toStringOrNull(obj.summary),
  };
}
