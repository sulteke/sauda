import { describe, expect, it } from "vitest";

import {
  formatHashtagWhitelist,
  MAX_TELEGRAM_HASHTAGS,
  normalizeHashtag,
  resolveHashtag,
  sanitizeHashtags,
  TELEGRAM_HASHTAG_LIST,
  TELEGRAM_HASHTAGS,
} from "./telegram-hashtags";

describe("the whitelist itself", () => {
  it("has no duplicates, by exact string or by lookup key", () => {
    expect(new Set(TELEGRAM_HASHTAG_LIST).size).toBe(TELEGRAM_HASHTAG_LIST.length);
    const keys = TELEGRAM_HASHTAG_LIST.map(normalizeHashtag);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts every tag with # and contains no whitespace", () => {
    for (const { tag } of TELEGRAM_HASHTAGS) {
      expect(tag.startsWith("#")).toBe(true);
      expect(tag).not.toMatch(/\s/);
      expect(tag.length).toBeGreaterThan(1);
    }
  });

  it("preserves the live channel's existing tags EXACTLY, including lower case", () => {
    // Changing these would split each tag in two on Telegram and orphan every
    // post already published under the current spelling.
    for (const tag of [
      "#Футболки",
      "#Рубашки",
      "#Свитшоты",
      "#Худи",
      "#Верх",
      "#низ",
      "#дети",
      "#school",
      "#головнойубор",
      "#сумка",
      "#аксессуары",
      "#Жакеты",
      "#Джинсы",
      "#Обувь",
      "#Трико",
      "#Классика",
      "#Очки",
      "#Шорты",
    ]) {
      expect(TELEGRAM_HASHTAG_LIST).toContain(tag);
    }
  });

  it("includes the new groups and shares tags listed under both women's and men's", () => {
    expect(TELEGRAM_HASHTAG_LIST).toContain("#Женскаяодежда");
    expect(TELEGRAM_HASHTAG_LIST).toContain("#Мужскаяодежда");
    expect(TELEGRAM_HASHTAG_LIST).toContain("#Кроссовки");
    expect(TELEGRAM_HASHTAG_LIST).toContain("#Детскаяодежда");
    expect(TELEGRAM_HASHTAG_LIST).toContain("#Streetwear");
    // Listed in both the women's and men's sections — stored once.
    for (const shared of ["#Брюки", "#Костюмы", "#Пальто", "#Куртки", "#Спортивнаяодежда"]) {
      expect(TELEGRAM_HASHTAG_LIST.filter((t) => t === shared)).toHaveLength(1);
    }
  });
});

describe("resolveHashtag", () => {
  it("resolves an exact tag to itself", () => {
    expect(resolveHashtag("#Худи")).toBe("#Худи");
  });

  it("tolerates a missing #, wrong case and stray punctuation", () => {
    expect(resolveHashtag("худи")).toBe("#Худи");
    expect(resolveHashtag("#ЖЕНСКАЯОДЕЖДА")).toBe("#Женскаяодежда");
    expect(resolveHashtag("#Женская одежда")).toBe("#Женскаяодежда");
    // Canonical output keeps the channel's existing lower case.
    expect(resolveHashtag("#Аксессуары")).toBe("#аксессуары");
  });

  it("rejects anything outside the whitelist", () => {
    expect(resolveHashtag("#ОбувьДляМужчин")).toBeNull();
    expect(resolveHashtag("#сделаноВКазахстане")).toBeNull();
    expect(resolveHashtag("")).toBeNull();
    expect(resolveHashtag("###")).toBeNull();
    expect(resolveHashtag(42)).toBeNull();
    expect(resolveHashtag(null)).toBeNull();
  });
});

describe("sanitizeHashtags", () => {
  it("drops invented tags and keeps whitelisted ones", () => {
    expect(sanitizeHashtags(["#Худи", "#ЭтоВыдумка", "#Кроссовки"])).toEqual([
      "#Худи",
      "#Кроссовки",
    ]);
  });

  it("deduplicates spelling variants of the same tag", () => {
    expect(sanitizeHashtags(["#Худи", "худи", "#ХУДИ"])).toEqual(["#Худи"]);
  });

  it(`caps the result at ${MAX_TELEGRAM_HASHTAGS}`, () => {
    const result = sanitizeHashtags([
      "#Худи",
      "#Футболки",
      "#Джинсы",
      "#Обувь",
      "#Кроссовки",
      "#Кеды",
      "#Топы",
    ]);
    expect(result).toHaveLength(MAX_TELEGRAM_HASHTAGS);
    expect(result).toEqual(["#Худи", "#Футболки", "#Джинсы", "#Обувь", "#Кроссовки"]);
  });

  it("returns an empty array for anything that is not a list", () => {
    expect(sanitizeHashtags(undefined)).toEqual([]);
    expect(sanitizeHashtags(null)).toEqual([]);
    expect(sanitizeHashtags("#Худи")).toEqual([]);
    expect(sanitizeHashtags({ hashtags: ["#Худи"] })).toEqual([]);
  });
});

describe("formatHashtagWhitelist", () => {
  it("lists every whitelisted tag, grouped", () => {
    const text = formatHashtagWhitelist();
    for (const tag of TELEGRAM_HASHTAG_LIST) expect(text).toContain(tag);
    expect(text).toContain("- Shoes:");
  });

  it("limits the rendering to a supplied subset", () => {
    const text = formatHashtagWhitelist(["#Худи", "#Кроссовки"]);
    expect(text).toContain("#Худи");
    expect(text).toContain("#Кроссовки");
    expect(text).not.toContain("#Джинсы");
  });
});
