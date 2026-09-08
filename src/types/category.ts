/**
 * Product-category detection types. Plain types — safe on server and client.
 *
 * `ProductCategory` is the minimal id+label pair used across DTOs and URLs.
 * `DetectedCategory` adds the score and the evidence (`matches`) explaining WHY
 * the category was assigned.
 */

/** Where a keyword was found. Drives the per-occurrence weight. */
export type CategoryMatchSource = "biography" | "hashtag" | "caption" | "mention";

/** One piece of evidence: a dictionary keyword found in a given source. */
export interface CategoryMatch {
  /** The dictionary keyword (stem) that matched. */
  keyword: string;
  /** Where it was found. */
  source: CategoryMatchSource;
  /** How many times it occurred in that source. */
  occurrences: number;
  /** Points contributed = occurrences × the source weight. */
  points: number;
}

/** A product category: stable latin `id` (storage / URLs) + display `label`. */
export interface ProductCategory {
  id: string;
  label: string;
}

/** A scored product category with the evidence that produced the score. */
export interface DetectedCategory extends ProductCategory {
  score: number;
  matches: CategoryMatch[];
}
