import type { CategoryMatchSource } from "@/types/category";

/**
 * Category detection configuration — the SINGLE place to tune detection.
 *
 * Edit this file to add categories, add keywords, change the per-source weights,
 * or move the threshold. The engine (src/lib/category-engine.ts) reads this
 * config and contains no category knowledge of its own, so the dictionary can
 * grow without touching the engine.
 *
 * Keywords are lowercase stems (Russian / Kazakh / English). Matching is
 * word-start with an optional inflected suffix, so "джинс" matches
 * "джинсы"/"джинсовый" but not a mid-word coincidence.
 */

export interface CategoryDictionaryEntry {
  /** Stable latin id used for storage and URLs. */
  id: string;
  /** Display label. */
  label: string;
  /** Lowercase keyword stems. */
  keywords: string[];
}

/** Points added per keyword occurrence, by source. */
export const SOURCE_WEIGHTS: Record<CategoryMatchSource, number> = {
  biography: 5,
  hashtag: 3,
  caption: 2,
  mention: 1,
};

/** Minimum score for a category to be assigned. */
export const SCORE_THRESHOLD = 3;

/**
 * The product-category dictionary. This is intentionally a small starter set —
 * extend it freely; the engine and everything downstream pick up new entries
 * with no code changes.
 */
export const CATEGORY_DICTIONARY: readonly CategoryDictionaryEntry[] = [
  { id: "futbolki", label: "Футболки", keywords: ["футболк", "tshirt", "t-shirt", "tee-shirt"] },
  { id: "rubashki", label: "Рубашки", keywords: ["рубаш", "shirt", "көйлек", "koylek"] },
  { id: "svitshoty", label: "Свитшоты", keywords: ["свитшот", "світшот", "sweatshirt"] },
  { id: "hudi", label: "Худи", keywords: ["худи", "hoodie", "толстовк"] },
  { id: "vetrovki", label: "Ветровки", keywords: ["ветровк", "windbreaker"] },
  { id: "joggery", label: "Джоггеры", keywords: ["джоггер", "джогер", "jogger"] },
  { id: "dzhinsy", label: "Джинсы", keywords: ["джинс", "jean", "denim"] },
  { id: "shorty", label: "Шорты", keywords: ["шорт", "shorts"] },
  // Garment types the shop list needed: without these a dress or coat shop has
  // no category to land in at all, and falls through to nothing.
  { id: "maiki", label: "Майки", keywords: ["майка", "майки", "майок", "майках", "tanktop"] },
  { id: "topy", label: "Топы", keywords: ["топы", "топик", "топов", "топами", "crop top"] },
  { id: "bluzki", label: "Блузки", keywords: ["блуз", "blouse"] },
  { id: "platya", label: "Платья", keywords: ["плать", "сукня", "dress"] },
  { id: "yubki", label: "Юбки", keywords: ["юбк", "skirt"] },
  { id: "bryuki", label: "Брюки", keywords: ["брюк", "штан", "trouser", "pants"] },
  { id: "kostyumy", label: "Костюмы", keywords: ["костюм", "suit"] },
  { id: "zhilety", label: "Жилеты", keywords: ["жилет", "vest", "безрукавк"] },
  { id: "svitery", label: "Свитеры", keywords: ["свитер", "джемпер", "sweater", "пуловер"] },
  { id: "kardigany", label: "Кардиганы", keywords: ["кардиган", "cardigan"] },
  { id: "kurtki", label: "Куртки", keywords: ["куртк", "бомбер", "jacket", "анорак"] },
  { id: "palto", label: "Пальто", keywords: ["пальто", "coat", "шуба"] },
  { id: "plashchi", label: "Плащи", keywords: ["плащ", "тренч", "raincoat", "trench"] },
  { id: "kombinezony", label: "Комбинезоны", keywords: ["комбинезон", "jumpsuit", "overall"] },
  {
    id: "sportivnaya-odezhda",
    label: "Спортивная одежда",
    keywords: ["спортивн", "sportswear", "фитнес", "леггинс", "activewear"],
  },
  {
    id: "verhnyaya-odezhda",
    label: "Верхняя одежда",
    keywords: ["верхняя одежда", "верхней одежд", "пуховик", "outerwear", "сыртқы киім"],
  },
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
