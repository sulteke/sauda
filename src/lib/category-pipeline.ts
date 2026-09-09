import type { CategoryMatch, DetectedCategory, ProductCategory } from "@/types/category";
import type { BoutiqueEnrichment } from "@/types/enrichment";
import type { InstagramBusinessAddress, InstagramExternalLink } from "@/types/instagram";

import {
  type AiCategoryProvider,
  AI_CONFIDENCE_THRESHOLD,
  type AiCategoryRequest,
  type AiCategoryResult,
  disabledAiCategoryProvider,
} from "./ai-category-provider";
import { enrichBoutique } from "./boutique-enrichment";
import {
  categoryLabel,
  DEFAULT_ENGINE_CONFIG,
  detectCategories,
  type EngineConfig,
} from "./category-engine";

/**
 * Multi-stage category pipeline (hybrid):
 *
 *   Instagram → Apify → Keyword Engine → AI Category Analyzer → Manual Review
 *
 * Category detection is a pipeline of independent stages whose results are
 * merged into one final product-category list:
 *
 *   Stage 1 — keyword detection (bio, captions, hashtags, mentions). Implemented
 *             by the keyword engine.
 *   Stage 2 — AI category analysis (text only). A pluggable provider seam; the
 *             default provider is disabled (no model connected), so it adds
 *             nothing until a real provider is wired in.
 *   Stage 2b — image classification. A separate pluggable HOOK (no-op default).
 *   Stage 3 — manual admin corrections. Admins add or remove categories; the
 *             overrides are stored so we always know which categories were
 *             auto-detected and which were added or removed by hand.
 *
 * `mergeCategories` combines the auto-detected stages with the manual overrides
 * (Stage 3) into the final list, preserving full provenance.
 */

export type CategoryStageName = "keyword" | "ai" | "image" | "manual";

/** A post as seen by the pipeline. Carries media so the image hook can use it. */
export interface CategoryPipelinePost {
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  imageUrl: string | null;
}

export interface CategoryDetectionInput {
  biography: string | null;
  avatarUrl: string | null;
  posts: CategoryPipelinePost[];
  // Extra context consumed by the AI stage. Optional so existing callers and the
  // keyword/image stages are unaffected.
  businessName?: string | null;
  username?: string | null;
  externalUrl?: string | null;
  externalUrls?: InstagramExternalLink[];
  businessAddress?: InstagramBusinessAddress | null;
}

// ---------------------------------------------------------------------------
// Stage 2 hook — image classification (interface only; NOT implemented yet)
// ---------------------------------------------------------------------------

export interface ImageClassificationInput {
  avatarUrl: string | null;
  imageUrls: string[];
}

/**
 * The seam for future image-based category detection. Implement this and pass it
 * to the pipeline (`imageClassifier`) to enable Stage 2 — nothing else changes.
 * It must return the same `DetectedCategory` shape as the keyword engine so the
 * merge treats every detection stage uniformly.
 */
export interface ImageCategoryClassifier {
  readonly name: string;
  classify(input: ImageClassificationInput): Promise<DetectedCategory[]>;
}

/** Default Stage 2 implementation: does nothing until a real classifier exists. */
export const noopImageClassifier: ImageCategoryClassifier = {
  name: "noop-image-classifier",
  async classify() {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Detection stages (Stage 1 + Stage 2)
// ---------------------------------------------------------------------------

export interface CategoryDetectionStage {
  readonly name: CategoryStageName;
  detect(input: CategoryDetectionInput): DetectedCategory[] | Promise<DetectedCategory[]>;
}

export function createKeywordStage(
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): CategoryDetectionStage {
  return {
    name: "keyword",
    detect: (input) =>
      detectCategories(
        {
          biography: input.biography,
          posts: input.posts.map((p) => ({
            caption: p.caption,
            hashtags: p.hashtags,
            mentions: p.mentions,
          })),
        },
        config,
      ),
  };
}

export function createImageStage(
  classifier: ImageCategoryClassifier = noopImageClassifier,
): CategoryDetectionStage {
  return {
    name: "image",
    detect: (input) =>
      classifier.classify({
        avatarUrl: input.avatarUrl,
        imageUrls: input.posts
          .map((p) => p.imageUrl)
          .filter((url): url is string => typeof url === "string" && url.length > 0),
      }),
  };
}

const uniqStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

/** Derives keyword-stage text input from the full detection input. */
function toKeywordInput(input: CategoryDetectionInput) {
  return {
    biography: input.biography,
    posts: input.posts.map((p) => ({
      caption: p.caption,
      hashtags: p.hashtags,
      mentions: p.mentions,
    })),
  };
}

/**
 * Builds the AI request (text only) from the pipeline input + allowed categories,
 * plus the keyword results and enrichment as prior context.
 */
function toAiRequest(
  input: CategoryDetectionInput,
  config: EngineConfig,
  context: { keywordResults: DetectedCategory[]; enrichment: BoutiqueEnrichment },
): AiCategoryRequest {
  return {
    businessName: input.businessName ?? null,
    username: input.username ?? null,
    biography: input.biography,
    externalUrl: input.externalUrl ?? null,
    externalUrls: input.externalUrls ?? [],
    businessAddress: input.businessAddress ?? null,
    captions: input.posts
      .map((p) => p.caption)
      .filter((c): c is string => typeof c === "string" && c.length > 0),
    hashtags: uniqStrings(input.posts.flatMap((p) => p.hashtags ?? [])),
    mentions: uniqStrings(input.posts.flatMap((p) => p.mentions ?? [])),
    allowedCategories: config.dictionary.map(({ id, label }) => ({ id, label })),
    keywordResults: context.keywordResults,
    enrichment: context.enrichment,
  };
}

/** Enrichment derived from the detection input (reuses the enrichment engine). */
function enrichmentFromInput(input: CategoryDetectionInput): BoutiqueEnrichment {
  return enrichBoutique({
    biography: input.biography,
    externalUrl: input.externalUrl ?? null,
    externalUrls: input.externalUrls ?? [],
    businessAddress: input.businessAddress ?? null,
  });
}

/**
 * Validates a raw AI result into DetectedCategory entries. Enforces the hard
 * rules regardless of the model: invented ids are dropped (must be an internal
 * category) and suggestions below the confidence threshold are ignored. Score =
 * confidence, so AI results merge uniformly with the keyword stage.
 */
export function aiSuggestionsToDetected(
  result: AiCategoryResult,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): DetectedCategory[] {
  const byId = new Map<string, DetectedCategory>();
  for (const suggestion of result.categories) {
    const label = categoryLabel(suggestion.id, config);
    if (!label) continue; // reject invented ids
    if (!(suggestion.confidence >= AI_CONFIDENCE_THRESHOLD)) continue; // below threshold
    const score = Math.round(Math.max(0, Math.min(100, suggestion.confidence)));
    const existing = byId.get(suggestion.id);
    if (!existing || score > existing.score) {
      byId.set(suggestion.id, { id: suggestion.id, label, score, matches: [] });
    }
  }
  return [...byId.values()];
}

/** Merges several detection result lists by id (sums scores, concatenates evidence). */
function mergeDetected(lists: DetectedCategory[][]): DetectedCategory[] {
  const byId = new Map<string, DetectedCategory>();
  for (const list of lists) {
    for (const result of list) {
      const existing = byId.get(result.id);
      if (existing) {
        existing.score += result.score;
        existing.matches = [...existing.matches, ...result.matches];
      } else {
        byId.set(result.id, { ...result, matches: [...result.matches] });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * AI detection stage. Wraps an AiCategoryProvider and converts its output into
 * DetectedCategory entries (see `aiSuggestionsToDetected`). The keyword results
 * and enrichment are computed here and passed as prior context so the model
 * validates/extends the keyword engine rather than classifying from scratch.
 * Defaults to the disabled provider.
 */
export function createAiCategoryStage(
  provider: AiCategoryProvider = disabledAiCategoryProvider,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): CategoryDetectionStage {
  return {
    name: "ai",
    detect: async (input) => {
      const keywordResults = detectCategories(toKeywordInput(input), config);
      const request = toAiRequest(input, config, {
        keywordResults,
        enrichment: enrichmentFromInput(input),
      });
      const result = await provider.analyze(request);
      return aiSuggestionsToDetected(result, config);
    },
  };
}

export interface CategoryPipelineOptions {
  config?: EngineConfig;
  /** AI provider for the AI stage (defaults to the disabled provider). */
  aiProvider?: AiCategoryProvider;
  imageClassifier?: ImageCategoryClassifier;
  /** Override the detection stages entirely (used in tests). */
  stages?: CategoryDetectionStage[];
}

/**
 * Runs the auto-detection stages (1 + 2) and merges their results by category,
 * summing scores and concatenating match evidence. Richest-first.
 */
export async function detectAutoCategories(
  input: CategoryDetectionInput,
  options: CategoryPipelineOptions = {},
): Promise<DetectedCategory[]> {
  const stages = options.stages ?? [
    createKeywordStage(options.config),
    createAiCategoryStage(options.aiProvider, options.config),
    createImageStage(options.imageClassifier),
  ];

  const lists = await Promise.all(stages.map((stage) => stage.detect(input)));
  return mergeDetected(lists);
}

/** A hybrid run's outputs, kept separate so keyword, AI and merged are all known. */
export interface HybridDetectionResult {
  /** Keyword engine result only (with match evidence) — never overwritten. */
  keyword: DetectedCategory[];
  /** Raw AI provider result (full structured output). */
  ai: AiCategoryResult;
  /** Final auto-detected list: keyword + validated AI, merged. */
  autoDetected: DetectedCategory[];
}

export interface HybridDetectionOptions {
  config?: EngineConfig;
  aiProvider?: AiCategoryProvider;
  /** Enrichment to pass to the AI as context (derived from the input if omitted). */
  enrichment?: BoutiqueEnrichment;
}

/**
 * Runs the hybrid pipeline — Keyword Engine → AI — with a SINGLE AI call, and
 * returns the keyword result, the raw AI result, and the merged auto-detected
 * list separately. The AI validates/extends the keyword engine; it never
 * replaces it. Used by the import pipeline so all three can be persisted.
 */
export async function runHybridDetection(
  input: CategoryDetectionInput,
  options: HybridDetectionOptions = {},
): Promise<HybridDetectionResult> {
  const config = options.config ?? DEFAULT_ENGINE_CONFIG;
  const provider = options.aiProvider ?? disabledAiCategoryProvider;

  const keyword = detectCategories(toKeywordInput(input), config);
  const enrichment = options.enrichment ?? enrichmentFromInput(input);
  const request = toAiRequest(input, config, { keywordResults: keyword, enrichment });

  const ai = await provider.analyze(request);
  const aiDetected = aiSuggestionsToDetected(ai, config);
  const autoDetected = mergeDetected([keyword, aiDetected]);

  return { keyword, ai, autoDetected };
}

// ---------------------------------------------------------------------------
// Stage 3 — manual overrides + the final merge
// ---------------------------------------------------------------------------

export interface ManualCategoryOverrides {
  /** Category ids added by an admin (that were not auto-detected). */
  added: string[];
  /** Category ids removed by an admin (that were auto-detected). */
  removed: string[];
}

export const EMPTY_OVERRIDES: ManualCategoryOverrides = { added: [], removed: [] };

/** A final category with full provenance. */
export interface CategoryAssignment extends ProductCategory {
  score: number;
  matches: CategoryMatch[];
  autoDetected: boolean;
  manuallyAdded: boolean;
}

export interface CategoryPipelineResult {
  /** The final product categories (auto ∪ added) \ removed, richest-first. */
  categories: CategoryAssignment[];
  /** Everything the detection stages produced, before manual overrides. */
  autoDetected: DetectedCategory[];
  overrides: ManualCategoryOverrides;
}

/**
 * Merges auto-detected categories (Stages 1 + 2) with manual overrides (Stage 3)
 * into the final list. Auto-detected categories that were manually removed are
 * dropped; manually-added categories that were not auto-detected are appended.
 */
export function mergeCategories(
  autoDetected: DetectedCategory[],
  overrides: ManualCategoryOverrides = EMPTY_OVERRIDES,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): CategoryPipelineResult {
  const removed = new Set(overrides.removed);
  const autoIds = new Set(autoDetected.map((c) => c.id));
  const categories: CategoryAssignment[] = [];

  // Auto-detected categories that survive removal.
  for (const c of autoDetected) {
    if (removed.has(c.id)) continue;
    categories.push({
      id: c.id,
      label: c.label,
      score: c.score,
      matches: c.matches,
      autoDetected: true,
      manuallyAdded: false,
    });
  }

  // Manually-added categories that are not auto-detected (and not removed).
  for (const id of overrides.added) {
    if (autoIds.has(id) || removed.has(id)) continue;
    const label = categoryLabel(id, config);
    if (!label) continue; // ignore unknown ids
    categories.push({
      id,
      label,
      score: 0,
      matches: [],
      autoDetected: false,
      manuallyAdded: true,
    });
  }

  // Auto-detected first (by score), manual additions after (by label).
  categories.sort((a, b) => {
    if (a.autoDetected !== b.autoDetected) return a.autoDetected ? -1 : 1;
    return b.score - a.score || a.label.localeCompare(b.label);
  });

  return {
    categories,
    autoDetected,
    overrides: { added: [...overrides.added], removed: [...overrides.removed] },
  };
}

/**
 * Applies an admin add/remove change to existing overrides, given which category
 * ids were auto-detected. Encodes the intent as the minimal override set so the
 * final list ends up as the admin expects:
 *  - adding an auto-detected id just clears any prior removal;
 *  - adding a non-detected id records a manual addition;
 *  - removing an auto-detected id records a removal;
 *  - removing a manually-added id simply drops the addition.
 */
export function applyCorrection(
  current: ManualCategoryOverrides,
  autoDetectedIds: readonly string[],
  change: { add?: string[]; remove?: string[] },
): ManualCategoryOverrides {
  const auto = new Set(autoDetectedIds);
  const added = new Set(current.added);
  const removed = new Set(current.removed);

  for (const id of change.add ?? []) {
    removed.delete(id);
    if (!auto.has(id)) added.add(id);
  }
  for (const id of change.remove ?? []) {
    added.delete(id);
    if (auto.has(id)) removed.add(id);
  }

  return { added: [...added], removed: [...removed] };
}

/** Convenience: run detection stages then merge with overrides in one call. */
export async function runCategoryPipeline(
  input: CategoryDetectionInput,
  overrides: ManualCategoryOverrides = EMPTY_OVERRIDES,
  options: CategoryPipelineOptions = {},
): Promise<CategoryPipelineResult> {
  const autoDetected = await detectAutoCategories(input, options);
  return mergeCategories(autoDetected, overrides, options.config);
}
