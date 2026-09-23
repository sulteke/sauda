import {
  MAX_TELEGRAM_HASHTAGS,
  resolveHashtag,
  sanitizeHashtags,
  TELEGRAM_HASHTAG_LIST,
} from "@/config/telegram-hashtags";

/**
 * Deterministic hashtag derivation — the NON-AI half of the hashtag system.
 *
 * It exists for two jobs, both of which must work without spending any model
 * quota:
 *  1. topping a thin AI reply up to the 2–5 target, and
 *  2. backfilling boutiques analyzed before hashtags existed.
 *
 * Everything here is evidence-driven and reproducible: a tag is only ever
 * emitted because a detected CATEGORY implies it or because a keyword actually
 * occurs in the boutique's own text. Nothing is guessed, nothing is random, and
 * the same input always yields the same output — so a backfill can be re-run
 * safely and reviewed like data, not like a model output.
 *
 * Category detection itself is untouched: this module only READS category ids.
 */

/** Desired number of hashtags on a post. Fewer is allowed when evidence is thin. */
export const MIN_TELEGRAM_HASHTAGS = 2;

/**
 * Category id → whitelist tags, most specific FIRST.
 *
 * The head of each list is the tag that directly names the category (so
 * "zhakety" always yields #Жакеты). The tail holds broader tags that the
 * category reliably implies — used only to top a post up, never in preference
 * to real textual evidence.
 */
const CATEGORY_HASHTAGS: Record<string, readonly string[]> = {
  futbolki: ["#Футболки", "#Верх"],
  rubashki: ["#Рубашки", "#Верх"],
  svitshoty: ["#Свитшоты", "#Верх"],
  hudi: ["#Худи", "#Верх"],
  vetrovki: ["#Куртки", "#Верх"],
  joggery: ["#низ", "#Спортивнаяодежда"],
  dzhinsy: ["#Джинсы", "#низ"],
  shorty: ["#Шорты", "#низ"],
  maiki: ["#Майки", "#Верх"],
  topy: ["#Топы", "#Верх"],
  bluzki: ["#Блузки", "#Верх"],
  platya: ["#Платья", "#Женскаяодежда"],
  yubki: ["#Юбки", "#низ", "#Женскаяодежда"],
  bryuki: ["#Брюки", "#низ"],
  kostyumy: ["#Костюмы", "#Классика"],
  zhilety: ["#Жилеты", "#Верх"],
  svitery: ["#Свитеры", "#Верх"],
  kardigany: ["#Кардиганы", "#Верх"],
  kurtki: ["#Куртки", "#Верхняяодежда"],
  palto: ["#Пальто", "#Верхняяодежда"],
  plashchi: ["#Плащи", "#Верхняяодежда"],
  kombinezony: ["#Комбинезоны"],
  "sportivnaya-odezhda": ["#Спортивнаяодежда", "#Sport"],
  "verhnyaya-odezhda": ["#Верхняяодежда"],
  klassika: ["#Классика", "#Деловойстиль"],
  zhakety: ["#Жакеты", "#Классика"],
  obuv: ["#Обувь"],
  kepki: ["#головнойубор"],
  ochki: ["#Очки", "#аксессуары"],
  sumki: ["#сумка", "#аксессуары"],
  aksessuary: ["#аксессуары"],
  "detskaya-odezhda": ["#Детскаяодежда", "#дети"],
  school: ["#school", "#Школьнаяформа", "#дети"],
};

/**
 * Keyword stems that justify a tag when they appear in the boutique's own text
 * (bio, description, post captions, post hashtags).
 *
 * Stems are deliberately long enough to avoid collisions — "поло" would match
 * "полотенце", so the rule requires "поло" only as a standalone-ish stem, and
 * short ambiguous words are omitted entirely rather than risk a wrong tag.
 */
const HASHTAG_KEYWORDS: readonly { tag: string; keywords: readonly string[] }[] = [
  // Audience
  { tag: "#Женскаяодежда", keywords: ["женск", "женщин", "women", "woman", "әйел"] },
  { tag: "#Мужскаяодежда", keywords: ["мужск", "мужчин", "men's", "menswear", "ерлер"] },
  { tag: "#Детскаяодежда", keywords: ["детск", "детям", "kids", "children", "балалар"] },
  { tag: "#дети", keywords: ["детск", "kids", "children", "балалар"] },
  { tag: "#Длямальчиков", keywords: ["мальчик", "boys", "ұлдар"] },
  { tag: "#Длядевочек", keywords: ["девочк", "girls", "қыздар"] },
  { tag: "#Детскаяобувь", keywords: ["детская обувь", "детскую обувь"] },
  { tag: "#Школьнаяформа", keywords: ["школьн", "мектеп", "school form"] },
  { tag: "#school", keywords: ["школ", "school", "мектеп"] },

  // Tops
  { tag: "#Футболки", keywords: ["футболк", "tshirt", "t-shirt"] },
  { tag: "#Рубашки", keywords: ["рубаш", "shirt"] },
  { tag: "#Свитшоты", keywords: ["свитшот", "sweatshirt"] },
  { tag: "#Худи", keywords: ["худи", "hoodie", "толстовк"] },
  { tag: "#Топы", keywords: ["топы", "топик", "топов"] },
  { tag: "#Майки", keywords: ["майка", "майки", "майок", "майках"] },
  { tag: "#Свитеры", keywords: ["свитер", "джемпер", "пуловер", "sweater"] },
  { tag: "#Толстовки", keywords: ["толстовк"] },
  { tag: "#Пиджаки", keywords: ["пиджак"] },
  { tag: "#Жилеты", keywords: ["жилет", "безрукавк"] },
  { tag: "#Блузки", keywords: ["блуз", "blouse"] },
  { tag: "#Поло", keywords: ["поло ", "футболка поло", "polo"] },
  { tag: "#Лонгсливы", keywords: ["лонгслив", "longsleeve"] },
  { tag: "#Жакеты", keywords: ["жакет", "пиджак", "blazer"] },
  { tag: "#Кардиганы", keywords: ["кардиган", "cardigan"] },

  // Bottoms
  { tag: "#Джинсы", keywords: ["джинс", "denim", "jeans"] },
  { tag: "#Брюки", keywords: ["брюк", "trouser", "штаны"] },
  { tag: "#Юбки", keywords: ["юбк", "skirt"] },
  { tag: "#Шорты", keywords: ["шорт", "shorts"] },
  { tag: "#Трико", keywords: ["трико"] },

  // Whole looks
  { tag: "#Платья", keywords: ["плать", "сукня", "dress", "көйлек"] },
  { tag: "#Костюмы", keywords: ["костюм", "suit"] },
  { tag: "#Комбинезоны", keywords: ["комбинезон", "jumpsuit"] },

  // Outerwear
  { tag: "#Пальто", keywords: ["пальто", "coat"] },
  { tag: "#Куртки", keywords: ["куртк", "ветровк", "jacket", "пуховик"] },
  { tag: "#Плащи", keywords: ["плащ", "тренч", "trench"] },
  { tag: "#Спортивнаяодежда", keywords: ["спортивн", "sportswear", "фитнес"] },

  // Season. These need the season to be SAID — a photo of a coat is not
  // evidence that the shop calls itself a winter-wear shop.
  { tag: "#Верхняяодежда", keywords: ["верхняя одежда", "верхней одежд", "outerwear"] },
  { tag: "#Зимняяодежда", keywords: ["зимняя одежда", "зимней одежд", "қысқы киім"] },
  { tag: "#Теплаяодежда", keywords: ["теплая одежда", "тёплая одежда"] },
  { tag: "#Демисезоннаяодежда", keywords: ["демисезон"] },
  { tag: "#Пуховики", keywords: ["пуховик"] },

  // Audience is one general tag; it pairs with a general garment tag rather
  // than fusing into one. Only when the shop actually says unisex.
  { tag: "#Унисексодежда", keywords: ["унисекс", "unisex"] },

  // Shoes
  { tag: "#Обувь", keywords: ["обув", "shoes", "аяқ киім"] },
  { tag: "#Кроссовки", keywords: ["кроссовк", "sneaker"] },
  { tag: "#Кеды", keywords: ["кеды", "кед ", "кедов"] },
  { tag: "#Туфли", keywords: ["туфл"] },
  { tag: "#Ботинки", keywords: ["ботин", "boots"] },
  { tag: "#Сапоги", keywords: ["сапог"] },
  { tag: "#Лоферы", keywords: ["лофер", "loafer"] },
  { tag: "#Сандалии", keywords: ["сандал", "sandal"] },

  // Accessories
  { tag: "#сумка", keywords: ["сумк", "сөмке", "клатч", "handbag"] },
  { tag: "#Рюкзаки", keywords: ["рюкзак", "backpack"] },
  { tag: "#Ремни", keywords: ["ремен", "ремн", "belt"] },
  { tag: "#Кошельки", keywords: ["кошельк", "wallet"] },
  { tag: "#Часы", keywords: ["часы", "наручн", "watch"] },
  { tag: "#Украшения", keywords: ["украшени", "jewelry", "әшекей"] },
  { tag: "#Бижутерия", keywords: ["бижутери"] },
  { tag: "#Шарфы", keywords: ["шарф", "scarf", "платок"] },
  { tag: "#Перчатки", keywords: ["перчатк", "glove"] },
  { tag: "#Очки", keywords: ["очк", "sunglass", "көзілдірік"] },
  { tag: "#головнойубор", keywords: ["кепк", "бейсболк", "головной убор", "шапк", "панам"] },
  { tag: "#аксессуары", keywords: ["аксессуар", "аксесуар", "accessor"] },

  // Style
  { tag: "#Классика", keywords: ["классик", "classic"] },
  { tag: "#Casual", keywords: ["casual", "кэжуал", "кежуал"] },
  { tag: "#Streetwear", keywords: ["streetwear", "стритвир", "street style", "уличн"] },
  { tag: "#Sport", keywords: ["спорт", "sport"] },
  { tag: "#Oversize", keywords: ["oversize", "оверсайз", "оверсайс"] },
  { tag: "#Минимализм", keywords: ["минимализм", "minimal"] },
  { tag: "#Деловойстиль", keywords: ["деловой", "офисн", "business style", "деловая"] },
  { tag: "#Винтаж", keywords: ["винтаж", "vintage"] },
];

/** Everything a derivation may look at. All optional — use whatever exists. */
export interface HashtagDerivationInput {
  /** Detected product-category ids, richest-first. Read only, never modified. */
  categoryIds?: readonly string[];
  /** Free text: bio, description, captions, profile hashtags. */
  text?: readonly (string | null | undefined)[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-start stem match with an optional inflected suffix — the same rule the
 * category engine uses, so "джинс" matches "джинсы"/"джинсовый" but never a
 * mid-word coincidence.
 */
function mentions(haystack: string, keyword: string): boolean {
  return new RegExp(`(?<!\\p{L})${escapeRegExp(keyword)}\\p{L}*`, "iu").test(haystack);
}

/** Tags implied by the detected categories, primary tags before broader ones. */
function fromCategories(categoryIds: readonly string[]): { primary: string[]; broader: string[] } {
  const primary: string[] = [];
  const broader: string[] = [];
  for (const id of categoryIds) {
    const [head, ...tail] = CATEGORY_HASHTAGS[id] ?? [];
    if (head) primary.push(head);
    broader.push(...tail);
  }
  return { primary, broader };
}

/** Tags justified by a keyword actually occurring in the boutique's own text. */
function fromText(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { tag, keywords } of HASHTAG_KEYWORDS) {
    if (keywords.some((keyword) => mentions(text, keyword))) found.push(tag);
  }
  // Emit in whitelist order so the result is stable regardless of rule order.
  return TELEGRAM_HASHTAG_LIST.filter((tag) => found.includes(tag));
}

/**
 * Derives whitelist hashtags from categories and text, most-justified first:
 * the tag naming each detected category, then tags with direct textual
 * evidence, then broader tags the categories imply. Deduplicated and capped.
 */
export function deriveHashtags(
  input: HashtagDerivationInput,
  limit = MAX_TELEGRAM_HASHTAGS,
): string[] {
  const { primary, broader } = fromCategories(input.categoryIds ?? []);
  const text = (input.text ?? []).filter(Boolean).join("\n").toLocaleLowerCase("ru-RU");
  return sanitizeHashtags([...primary, ...fromText(text), ...broader], limit);
}

/**
 * Brings a hashtag set up to the target range WITHOUT calling a model.
 *
 * The supplied tags (typically the AI's) keep their order and priority; the
 * deterministic derivation only fills the remainder, and only up to `min`.
 * When evidence runs out the result is simply shorter — padding a post with
 * tags nothing supports would be worse than showing fewer.
 */
export function completeHashtags(
  hashtags: unknown,
  input: HashtagDerivationInput,
  options: { min?: number; max?: number } = {},
): string[] {
  const max = options.max ?? MAX_TELEGRAM_HASHTAGS;
  const min = Math.min(options.min ?? MIN_TELEGRAM_HASHTAGS, max);
  const chosen = sanitizeHashtags(hashtags, max);
  if (chosen.length >= min) return chosen;

  for (const tag of deriveHashtags(input, max)) {
    if (chosen.length >= min) break;
    if (!chosen.includes(tag)) chosen.push(tag);
  }
  return chosen.slice(0, max);
}

/** Whether `raw` already holds at least one usable whitelist hashtag. */
export function hasUsableHashtags(raw: unknown): boolean {
  return sanitizeHashtags(raw).length > 0;
}

export { resolveHashtag };
