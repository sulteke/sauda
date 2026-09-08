import type { CategoryMatch, DetectedCategory, ProductCategory } from "@/types/category";

import {
  categoryLabel,
  DEFAULT_ENGINE_CONFIG,
  detectCategories,
  type EngineConfig,
} from "./category-engine";

/**
 * Multi-stage category pipeline.
 *
 * Category detection is a pipeline of independent stages whose results are
 * merged into one final product-category list:
 *
 *   Stage 1 — keyword detection (bio, captions, hashtags, mentions). Implemented
 *             by the keyword engine.
 *   Stage 2 — image classification. A pluggable HOOK only: the interface is
 *             defined here and a no-op default is wired in, so a real classifier
 *             can be dropped in later without touching the pipeline or callers.
 *   Stage 3 — manual admin corrections. Admins add or remove categories; the
 *             overrides are stored so we always know which categories were
 *             auto-detected and which were added or removed by hand.
 *
 * `mergeCategories` combines the auto-detected stages (1 + 2) with the manual
 * overrides (3) into the final list, preserving full provenance.
 */

export type CategoryStageName = "keyword" | "image" | "manual";

/** A post as seen by the pipeline. Carries media so Stage 2 can use images. */
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

export interface CategoryPipelineOptions {
  config?: EngineConfig;
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
  const stages =
    options.stages ?? [createKeywordStage(options.config), createImageStage(options.imageClassifier)];

  const byId = new Map<string, DetectedCategory>();
  for (const stage of stages) {
    const results = await stage.detect(input);
    for (const result of results) {
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
