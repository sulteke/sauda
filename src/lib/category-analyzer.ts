import type { DetectedCategory, ProductCategory } from "@/types/category";

/**
 * Automatic product-category detection for imported boutiques.
 *
 * Every keyword occurrence contributes a weighted score depending on WHERE it
 * was found; a category is assigned when its total reaches SCORE_THRESHOLD. A
 * boutique can match several categories. Keywords are Russian (primary),
 * Kazakh and English, given as lowercase stems: matching is word-start with an
 * optional inflected suffix, so "джинс" matches "джинсы"/"джинсовый" but not a
 * mid-word coincidence like "очки" inside "цветочки".
 */

/** Weight per keyword occurrence, by source. */
export const CATEGORY_WEIGHTS = {
  biography: 5,
  hashtag: 3,
  caption: 2,
  mention: 1,
} as const;

/** Minimum score for a category to be assigned. Tunable. */
export const SCORE_THRESHOLD = 3;

interface CategoryDefinition extends ProductCategory {
  /** Lowercase keyword stems (ru / kz / en). */
  keywords: string[];
}

/**
 * The keyword dictionary. Order here is the canonical order of the categories.
 * Stems are chosen to be safe word-start prefixes to limit false positives.
 */
export const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  { id: "futbolki", label: "Футболки", keywords: ["футболк", "tshirt", "t-shirt", "tee-shirt"] },
  { id: "rubashki", label: "Рубашки", keywords: ["рубаш", "shirt", "көйлек", "koylek"] },
  { id: "svitshoty", label: "Свитшоты", keywords: ["свитшот", "світшот", "sweatshirt"] },
  { id: "hudi", label: "Худи", keywords: ["худи", "hoodie", "толстовк"] },
  { id: "vetrovki", label: "Ветровки", keywords: ["ветровк", "windbreaker"] },
  { id: "joggery", label: "Джоггеры", keywords: ["джоггер", "джогер", "jogger"] },
  { id: "dzhinsy", label: "Джинсы", keywords: ["джинс", "jean", "denim"] },
  { id: "shorty", label: "Шорты", keywords: ["шорт", "shorts"] },
  { id: "klassika", label: "Классика", keywords: ["классик", "classic"] },
  { id: "zhakety", label: "Жакеты", keywords: ["жакет", "пиджак", "blazer", "jacket"] },
  {
    id: "obuv",
    label: "Обувь",
    keywords: [
      "обув",
      "кроссовк",
      "кед",
      "ботин",
      "туфл",
      "сапог",
      "сникер",
      "shoe",
      "sneaker",
      "boot",
      "аяқ киім",
    ],
  },
  { id: "kepki", label: "Кепки", keywords: ["кепк", "кепи", "бейсболк", "snapback"] },
  { id: "ochki", label: "Очки", keywords: ["очк", "sunglass", "glasses", "көзілдірік"] },
  {
    id: "sumki",
    label: "Сумки",
    keywords: ["сумк", "рюкзак", "backpack", "клатч", "сөмке", "bag"],
  },
  {
    id: "aksessuary",
    label: "Аксессуары",
    keywords: ["аксессуар", "аксесуар", "accessor", "ремен", "браслет", "часы", "бижутери"],
  },
  {
    id: "detskaya-odezhda",
    label: "Детская одежда",
    keywords: ["детск", "kids", "children", "baby", "балалар"],
  },
  { id: "school", label: "School", keywords: ["школ", "school", "мектеп"] },
] as const;

/** All product categories (id + label), in canonical order. */
export const PRODUCT_CATEGORIES: readonly ProductCategory[] = CATEGORY_DEFINITIONS.map(
  ({ id, label }) => ({ id, label }),
);

const LABEL_BY_ID = new Map(CATEGORY_DEFINITIONS.map((c) => [c.id, c.label]));

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
 * suffix. Unicode-aware so Cyrillic/Kazakh letters are treated as word chars.
 */
function countOccurrences(text: string, keyword: string): number {
  if (!text) return 0;
  const pattern = new RegExp(`(?<!\\p{L})${escapeRegExp(keyword)}\\p{L}*`, "giu");
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Analyzes a boutique's text and returns the product categories that reached the
 * threshold, richest-first. Pure and deterministic — no I/O.
 */
export function analyzeCategories(input: CategoryAnalysisInput): DetectedCategory[] {
  const biography = input.biography ?? "";
  const captions = input.posts.map((p) => p.caption ?? "").join("\n");
  const hashtags = input.posts.flatMap((p) => p.hashtags ?? []).join(" ");
  const mentions = input.posts.flatMap((p) => p.mentions ?? []).join(" ");

  const detected: DetectedCategory[] = [];

  for (const category of CATEGORY_DEFINITIONS) {
    let score = 0;
    for (const keyword of category.keywords) {
      score += countOccurrences(biography, keyword) * CATEGORY_WEIGHTS.biography;
      score += countOccurrences(hashtags, keyword) * CATEGORY_WEIGHTS.hashtag;
      score += countOccurrences(captions, keyword) * CATEGORY_WEIGHTS.caption;
      score += countOccurrences(mentions, keyword) * CATEGORY_WEIGHTS.mention;
    }
    if (score >= SCORE_THRESHOLD) {
      detected.push({ id: category.id, label: category.label, score });
    }
  }

  return detected.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Resolves stored category ids back to id+label pairs (canonical order),
 * dropping any unknown ids. Used when building DTOs from the database.
 */
export function resolveProductCategories(ids: readonly string[]): ProductCategory[] {
  const wanted = new Set(ids);
  return CATEGORY_DEFINITIONS.filter((c) => wanted.has(c.id)).map(({ id, label }) => ({
    id,
    label,
  }));
}

/** Looks up a category label by id (null if unknown). */
export function categoryLabel(id: string): string | null {
  return LABEL_BY_ID.get(id) ?? null;
}
