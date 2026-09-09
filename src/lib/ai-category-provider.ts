import type { ProductCategory } from "@/types/category";
import type { InstagramBusinessAddress, InstagramExternalLink } from "@/types/instagram";

/**
 * AI category stage — provider abstraction ONLY.
 *
 * This file defines the seam for an LLM-backed category analyzer (OpenAI /
 * Gemini / Claude). It does NOT call any model. A concrete provider implements
 * `AiCategoryProvider.analyze`, typically by feeding `buildAiCategoryPrompt` to
 * a model and passing the model's reply through `parseAiCategoryResult`.
 *
 * Hard rules enforced in code (never trust the model):
 *  - the AI may ONLY choose from the allowed internal categories — invented ids
 *    are dropped downstream in the pipeline stage;
 *  - a suggestion below the confidence threshold is ignored.
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
  summary: string | null;
}

export const EMPTY_AI_RESULT: AiCategoryResult = {
  categories: [],
  city: null,
  mall: null,
  address: null,
  summary: null,
};

/**
 * The pluggable seam. Implement this with OpenAI/Gemini/Claude later and wire it
 * via `getAiCategoryProvider()` — nothing in the pipeline changes.
 */
export interface AiCategoryProvider {
  readonly name: string;
  analyze(request: AiCategoryRequest): Promise<AiCategoryResult>;
}

/** Default provider: no model connected yet, so it contributes nothing. */
export const disabledAiCategoryProvider: AiCategoryProvider = {
  name: "disabled",
  async analyze() {
    return { categories: [], city: null, mall: null, address: null, summary: null };
  },
};

/**
 * Resolves the active AI category provider. Returns the disabled provider until
 * a real one is implemented and selected here (e.g. via an env flag). This is
 * the single place a future OpenAI/Gemini/Claude provider gets plugged in.
 */
export function getAiCategoryProvider(): AiCategoryProvider {
  return disabledAiCategoryProvider;
}

/**
 * Builds the instruction text a concrete provider would send to its model. Lists
 * the allowed categories, the strict JSON schema, and the hard rules. Ready to
 * use but not sent anywhere by this module.
 */
export function buildAiCategoryPrompt(request: AiCategoryRequest): string {
  const allowed = request.allowedCategories.map((c) => `- ${c.id} (${c.label})`).join("\n");
  const data = JSON.stringify(
    {
      businessName: request.businessName,
      username: request.username,
      biography: request.biography,
      externalUrl: request.externalUrl,
      externalUrls: request.externalUrls,
      businessAddress: request.businessAddress,
      captions: request.captions,
      hashtags: request.hashtags,
      mentions: request.mentions,
    },
    null,
    2,
  );

  return [
    "You classify an Instagram business into product categories.",
    "Choose ONLY from the allowed category ids below. Never invent a category id.",
    `Include a category ONLY if your confidence is ${AI_CONFIDENCE_THRESHOLD} or higher (scale 0-100). If none qualify, return an empty "categories" array.`,
    "Respond with STRICT JSON only — no markdown, no commentary — matching exactly this schema:",
    '{"categories":[{"id":"<allowed id>","confidence":0-100,"reason":"..."}],"city":"...","mall":"...","address":"...","summary":"..."}',
    "Use null for city, mall, address or summary when unknown.",
    "",
    "Allowed categories:",
    allowed,
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
 * result, and malformed category entries are dropped. Does NOT apply the
 * allowed-id / confidence rules (the pipeline stage enforces those uniformly).
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
    summary: toStringOrNull(obj.summary),
  };
}
