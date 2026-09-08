/**
 * Product categories auto-detected from a boutique's Instagram text. `id` is a
 * stable latin slug (used in storage and URLs); `label` is the display name.
 * Plain types — safe on server and client.
 */
export interface ProductCategory {
  id: string;
  label: string;
}

/** A product category together with the score that earned it during analysis. */
export interface DetectedCategory extends ProductCategory {
  score: number;
}
