import { describe, expect, it } from "vitest";

import { MAX_TELEGRAM_HASHTAGS, TELEGRAM_HASHTAG_LIST } from "@/config/telegram-hashtags";

import {
  completeHashtags,
  deriveHashtags,
  hasUsableHashtags,
  MIN_TELEGRAM_HASHTAGS,
} from "./hashtag-derivation";

const whitelisted = (tags: string[]) => tags.every((t) => TELEGRAM_HASHTAG_LIST.includes(t));

describe("deriveHashtags — categories", () => {
  it("always names the detected category first", () => {
    expect(deriveHashtags({ categoryIds: ["zhakety"] })[0]).toBe("#Жакеты");
    expect(deriveHashtags({ categoryIds: ["dzhinsy"] })[0]).toBe("#Джинсы");
    expect(deriveHashtags({ categoryIds: ["obuv"] })[0]).toBe("#Обувь");
  });

  it("covers every category in the dictionary with whitelisted tags", () => {
    const ids = [
      "futbolki", "rubashki", "svitshoty", "hudi", "vetrovki", "joggery", "dzhinsy", "shorty",
      "klassika", "zhakety", "obuv", "kepki", "ochki", "sumki", "aksessuary",
      "detskaya-odezhda", "school",
    ];
    for (const id of ids) {
      const tags = deriveHashtags({ categoryIds: [id] });
      expect(tags.length, `category ${id} produced nothing`).toBeGreaterThan(0);
      expect(whitelisted(tags), `category ${id} produced a non-whitelist tag`).toBe(true);
    }
  });

  it("keeps category order (richest-first) in the output", () => {
    const tags = deriveHashtags({ categoryIds: ["obuv", "dzhinsy"] });
    expect(tags.indexOf("#Обувь")).toBeLessThan(tags.indexOf("#Джинсы"));
  });

  it("ignores unknown category ids instead of inventing a tag", () => {
    expect(deriveHashtags({ categoryIds: ["not-a-category"] })).toEqual([]);
  });
});

describe("deriveHashtags — text evidence", () => {
  it("matches the user's example: Жакеты + женская/деловая description", () => {
    const tags = deriveHashtags({
      categoryIds: ["zhakety"],
      text: ["Женская одежда, деловой стиль, классика"],
    });
    expect(tags[0]).toBe("#Жакеты");
    expect(tags).toContain("#Женскаяодежда");
    expect(tags).toContain("#Классика");
    expect(tags).toContain("#Деловойстиль");
  });

  it("reads Russian, Kazakh and English evidence", () => {
    expect(deriveHashtags({ text: ["Кроссовки и кеды"] })).toContain("#Кроссовки");
    expect(deriveHashtags({ text: ["Балалар киімі"] })).toContain("#Детскаяодежда");
    expect(deriveHashtags({ text: ["streetwear and oversize fits"] })).toContain("#Streetwear");
  });

  it("matches at word start with inflections, never mid-word", () => {
    // "джинсовая" is an inflection of the stem → matches.
    expect(deriveHashtags({ text: ["джинсовая куртка"] })).toContain("#Джинсы");
    // No stem present → no tag. "полотенце" must not trigger #Поло.
    expect(deriveHashtags({ text: ["полотенце для дома"] })).not.toContain("#Поло");
  });

  it("emits nothing when the text carries no evidence", () => {
    expect(deriveHashtags({ text: ["Просто магазин", null, undefined] })).toEqual([]);
    expect(deriveHashtags({})).toEqual([]);
  });

  it("is deterministic — same input, same output, every time", () => {
    const input = { categoryIds: ["obuv"], text: ["Кроссовки, кеды, туфли, ботинки, сапоги"] };
    const runs = Array.from({ length: 5 }, () => deriveHashtags(input).join(" "));
    expect(new Set(runs).size).toBe(1);
  });

  it("never exceeds the maximum", () => {
    const tags = deriveHashtags({
      categoryIds: ["obuv", "dzhinsy", "hudi", "futbolki", "sumki", "ochki"],
      text: ["женская мужская детская одежда кроссовки кеды туфли сумки часы очки"],
    });
    expect(tags).toHaveLength(MAX_TELEGRAM_HASHTAGS);
    expect(whitelisted(tags)).toBe(true);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("completeHashtags — topping up a thin AI reply", () => {
  it("keeps a sufficient AI reply untouched", () => {
    const ai = ["#Худи", "#Джинсы", "#Streetwear"];
    expect(completeHashtags(ai, { categoryIds: ["obuv"] })).toEqual(ai);
  });

  it("tops a single AI tag up to the 2–5 target from real evidence", () => {
    const result = completeHashtags(["#Худи"], {
      categoryIds: ["dzhinsy"],
      text: ["Мужская одежда, streetwear"],
    });
    expect(result[0]).toBe("#Худи"); // the AI's pick keeps priority
    expect(result.length).toBeGreaterThanOrEqual(MIN_TELEGRAM_HASHTAGS);
    expect(whitelisted(result)).toBe(true);
  });

  it("derives the whole set when the AI returned nothing", () => {
    const result = completeHashtags([], {
      categoryIds: ["zhakety"],
      text: ["Женская классика"],
    });
    expect(result.length).toBeGreaterThanOrEqual(MIN_TELEGRAM_HASHTAGS);
    expect(result).toContain("#Жакеты");
  });

  it("drops invalid AI tags before topping up", () => {
    const result = completeHashtags(["#ВыдуманныйТег", "#Худи"], {
      categoryIds: ["dzhinsy"],
    });
    expect(result).not.toContain("#ВыдуманныйТег");
    expect(result).toContain("#Худи");
    expect(whitelisted(result)).toBe(true);
  });

  it("removes duplicates, including spelling variants", () => {
    const result = completeHashtags(["#Худи", "худи", "#ХУДИ"], { categoryIds: ["hudi"] });
    expect(result.filter((t) => t === "#Худи")).toHaveLength(1);
    expect(new Set(result).size).toBe(result.length);
  });

  it("never pads beyond the maximum", () => {
    const result = completeHashtags(["#Худи", "#Джинсы", "#Обувь", "#Очки", "#сумка", "#Топы"], {
      categoryIds: ["obuv"],
    });
    expect(result).toHaveLength(MAX_TELEGRAM_HASHTAGS);
  });

  it("stays short rather than padding with unsupported tags", () => {
    // One AI tag, and no category or text evidence to justify a second.
    const result = completeHashtags(["#Худи"], { categoryIds: [], text: ["нет улик"] });
    expect(result).toEqual(["#Худи"]);
  });

  it("handles malformed AI payloads without throwing", () => {
    expect(completeHashtags(null, {})).toEqual([]);
    expect(completeHashtags("#Худи", {})).toEqual([]);
    expect(completeHashtags(undefined, { categoryIds: ["hudi"] })).toContain("#Худи");
  });
});

describe("hasUsableHashtags", () => {
  it("is true only for a set containing a whitelisted tag", () => {
    expect(hasUsableHashtags(["#Худи"])).toBe(true);
    expect(hasUsableHashtags(["#Выдумка"])).toBe(false);
    expect(hasUsableHashtags([])).toBe(false);
    expect(hasUsableHashtags(null)).toBe(false);
  });
});
