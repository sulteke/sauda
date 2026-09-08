import {
  CATEGORY_DICTIONARY,
  type CategoryDictionaryEntry,
  SCORE_THRESHOLD,
  SOURCE_WEIGHTS,
} from "@/config/category-dictionary";
import type {
  CategoryMatch,
  CategoryMatchSource,
  DetectedCategory,
  ProductCategory,
} from "@/types/category";

/**
 * Category Detection Engine.
 *
 * Pure, provider-independent scoring machinery. It knows how to tokenize text,
 * match keywords and accumulate weighted, *explained* scores — but it holds no
 * category knowledge itself: the dictionary, weights and threshold all come from
 * `@/config/category-dictionary` (or an injected `EngineConfig`, which makes the
 * engine trivial to unit-test and to reuse with alternate dictionaries).
 */

export interface EngineConfig {
  dictionary: readonly CategoryDictionaryEntry[];
  weights: Record<CategoryMatchSource, number>;
  threshold: number;
}

/** The default configuration, sourced entirely from the config file. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  dictionary: CATEGORY_DICTIONARY,
  weights: SOURCE_WEIGHTS,
  threshold: SCORE_THRESHOLD,
};

/** Every product category (id + label) in dictionary order — the pick list. */
export const ALL_PRODUCT_CATEGORIES: ProductCategory[] = CATEGORY_DICTIONARY.map(
  ({ id, label }) => ({ id, label }),
);

export interface CategoryAnalysisPost {
  caption: string | null;
  hashtags: string[];
  mentions: string[];
}

export interface CategoryAnalysisInput {
  biography: string | null;
  posts: CategoryAnalysisPost[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Counts word-start occurrences of `keyword` in `text`, tolerating an inflected
 * suffix. Unicode-aware so Cyrillic / Kazakh letters count as word characters,
 * so "джинс" matches "джинсы" but "очк" does NOT match inside "цветочки".
 */
function countOccurrences(text: string, keyword: string): number {
  if (!text || !keyword) return 0;
  const pattern = new RegExp(`(?<!\\p{L})${escapeRegExp(keyword)}\\p{L}*`, "giu");
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/** Collapses the analysis input into one text blob per weighted source. */
function toSources(input: CategoryAnalysisInput): Record<CategoryMatchSource, string> {
  return {
    biography: input.biography ?? "",
    caption: input.posts.map((p) => p.caption ?? "").join("\n"),
    hashtag: input.posts.flatMap((p) => p.hashtags ?? []).join(" "),
    mention: input.posts.flatMap((p) => p.mentions ?? []).join(" "),
  };
}

/**
 * Scores EVERY category in the dictionary against the input and records the
 * evidence (which keyword matched, in which source, how many times, and the
 * points it contributed). Returned in dictionary order; score may be 0.
 */
export function scoreCategories(
  input: CategoryAnalysisInput,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): DetectedCategory[] {
  const sources = toSources(input);
  const sourceNames = Object.keys(sources) as CategoryMatchSource[];

  return config.dictionary.map((category) => {
    const matches: CategoryMatch[] = [];
    let score = 0;

    for (const keyword of category.keywords) {
      for (const source of sourceNames) {
        const occurrences = countOccurrences(sources[source], keyword);
        if (occurrences === 0) continue;
        const points = occurrences * config.weights[source];
        score += points;
        matches.push({ keyword, source, occurrences, points });
      }
    }

    // Strongest evidence first, so the "why" reads top-down.
    matches.sort((a, b) => b.points - a.points || a.source.localeCompare(b.source));
    return { id: category.id, label: category.label, score, matches };
  });
}

/**
 * Detects the assigned categories: those whose score reaches the threshold,
 * richest-first. Each carries its evidence. A boutique can match several.
 */
export function detectCategories(
  input: CategoryAnalysisInput,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): DetectedCategory[] {
  return scoreCategories(input, config)
    .filter((category) => category.score >= config.threshold)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Resolves stored category ids back to id+label pairs (dictionary order),
 * dropping unknown ids. Used when building DTOs from the database.
 */
export function resolveProductCategories(
  ids: readonly string[],
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): ProductCategory[] {
  const wanted = new Set(ids);
  return config.dictionary
    .filter((c) => wanted.has(c.id))
    .map(({ id, label }) => ({ id, label }));
}

/** Looks up a category label by id (null if unknown). */
export function categoryLabel(
  id: string,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
): string | null {
  return config.dictionary.find((c) => c.id === id)?.label ?? null;
}
