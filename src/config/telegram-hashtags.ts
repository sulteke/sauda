/**
 * Telegram hashtag whitelist — the ONLY hashtags that may ever appear in a post.
 *
 * The AI is given this list and told to pick from it; whatever it returns is
 * then re-validated here, so an invented or misspelled tag can never reach the
 * channel. Matching is spelling-tolerant (case and punctuation are ignored) but
 * the OUTPUT is always the canonical string below.
 *
 * Casing note: the first group is the set already used in the live channel and
 * is reproduced EXACTLY as published (including `#низ`, `#дети`, `#сумка`,
 * `#аксессуары`, `#головнойубор` in lower case). Normalizing them would split
 * each of those tags in two on Telegram, orphaning every existing post.
 */

export type TelegramHashtagGroup =
  | "Core"
  | "Women"
  | "Men"
  | "Shoes"
  | "Accessories"
  | "Children"
  | "Style";

export interface TelegramHashtag {
  /** Canonical tag, exactly as it must be rendered (leading "#" included). */
  tag: string;
  group: TelegramHashtagGroup;
}

/** Target 2–5 tags per post; never more than this. */
export const MAX_TELEGRAM_HASHTAGS = 5;

export const TELEGRAM_HASHTAGS: readonly TelegramHashtag[] = [
  // Already in use in the channel — casing preserved verbatim.
  { tag: "#Футболки", group: "Core" },
  { tag: "#Рубашки", group: "Core" },
  { tag: "#Свитшоты", group: "Core" },
  { tag: "#Худи", group: "Core" },
  { tag: "#Верх", group: "Core" },
  { tag: "#низ", group: "Core" },
  { tag: "#дети", group: "Core" },
  { tag: "#school", group: "Core" },
  { tag: "#головнойубор", group: "Core" },
  { tag: "#сумка", group: "Core" },
  { tag: "#аксессуары", group: "Core" },
  { tag: "#Жакеты", group: "Core" },
  { tag: "#Джинсы", group: "Core" },
  { tag: "#Обувь", group: "Core" },
  { tag: "#Трико", group: "Core" },
  { tag: "#Классика", group: "Core" },
  { tag: "#Очки", group: "Core" },
  { tag: "#Шорты", group: "Core" },

  { tag: "#Женскаяодежда", group: "Women" },
  { tag: "#Платья", group: "Women" },
  { tag: "#Топы", group: "Women" },
  { tag: "#Блузки", group: "Women" },
  { tag: "#Юбки", group: "Women" },
  { tag: "#Кардиганы", group: "Women" },

  { tag: "#Мужскаяодежда", group: "Men" },
  { tag: "#Поло", group: "Men" },
  { tag: "#Лонгсливы", group: "Men" },

  // Listed under both women's and men's clothing — one shared tag, not two.
  { tag: "#Брюки", group: "Core" },
  { tag: "#Костюмы", group: "Core" },
  { tag: "#Пальто", group: "Core" },
  { tag: "#Куртки", group: "Core" },
  { tag: "#Спортивнаяодежда", group: "Core" },

  { tag: "#Кроссовки", group: "Shoes" },
  { tag: "#Кеды", group: "Shoes" },
  { tag: "#Туфли", group: "Shoes" },
  { tag: "#Ботинки", group: "Shoes" },
  { tag: "#Сапоги", group: "Shoes" },
  { tag: "#Лоферы", group: "Shoes" },
  { tag: "#Сандалии", group: "Shoes" },

  { tag: "#Рюкзаки", group: "Accessories" },
  { tag: "#Ремни", group: "Accessories" },
  { tag: "#Кошельки", group: "Accessories" },
  { tag: "#Часы", group: "Accessories" },
  { tag: "#Украшения", group: "Accessories" },
  { tag: "#Бижутерия", group: "Accessories" },
  { tag: "#Шарфы", group: "Accessories" },
  { tag: "#Перчатки", group: "Accessories" },

  { tag: "#Детскаяодежда", group: "Children" },
  { tag: "#Детскаяобувь", group: "Children" },
  { tag: "#Школьнаяформа", group: "Children" },
  { tag: "#Длямальчиков", group: "Children" },
  { tag: "#Длядевочек", group: "Children" },

  { tag: "#Casual", group: "Style" },
  { tag: "#Streetwear", group: "Style" },
  { tag: "#Sport", group: "Style" },
  { tag: "#Oversize", group: "Style" },
  { tag: "#Минимализм", group: "Style" },
  { tag: "#Деловойстиль", group: "Style" },
  { tag: "#Винтаж", group: "Style" },
];

/** Canonical tags in whitelist order — what the AI is shown and may return. */
export const TELEGRAM_HASHTAG_LIST: readonly string[] = TELEGRAM_HASHTAGS.map((h) => h.tag);

/**
 * Lookup key for a hashtag: drop "#", drop every non letter/digit, lower case.
 * "#Женская одежда", "женскаяодежда" and "#ЖЕНСКАЯОДЕЖДА" all map to the same
 * key, so a small spelling wobble from the model still resolves to the
 * canonical tag instead of being thrown away.
 */
export function normalizeHashtag(raw: string): string {
  return raw.replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ru-RU");
}

const BY_KEY = new Map(TELEGRAM_HASHTAGS.map((h) => [normalizeHashtag(h.tag), h.tag]));

/** The canonical whitelist tag for `raw`, or null when it is not whitelisted. */
export function resolveHashtag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = normalizeHashtag(raw);
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/**
 * Validates an arbitrary model reply into whitelisted, deduplicated canonical
 * tags, capped at MAX_TELEGRAM_HASHTAGS. Anything invented is silently dropped —
 * the whitelist is enforced in code, never trusted to the prompt.
 */
export function sanitizeHashtags(raw: unknown, limit = MAX_TELEGRAM_HASHTAGS): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const tag = resolveHashtag(entry);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Renders hashtags for the prompt, grouped so the model reads them easily.
 * Defaults to the full whitelist; a caller may pass a subset. Values outside
 * the whitelist are dropped — offering them would only invite invalid replies.
 */
export function formatHashtagWhitelist(tags: readonly string[] = TELEGRAM_HASHTAG_LIST): string {
  const allowed = new Set(tags.map((tag) => resolveHashtag(tag)).filter(Boolean));
  const groups = new Map<TelegramHashtagGroup, string[]>();
  for (const { tag, group } of TELEGRAM_HASHTAGS) {
    if (!allowed.has(tag)) continue;
    const list = groups.get(group);
    if (list) list.push(tag);
    else groups.set(group, [tag]);
  }
  return [...groups.entries()].map(([group, list]) => `- ${group}: ${list.join(" ")}`).join("\n");
}
