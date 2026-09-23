import { describe, expect, it } from "vitest";

import { CATEGORY_DICTIONARY } from "@/config/category-dictionary";
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

describe("the clothing taxonomy", () => {
  // A typo in either map shows up here: an unmapped category derives nothing,
  // and a misspelled tag is dropped by the whitelist, so the result is empty.
  it("gives EVERY product category at least one whitelisted hashtag", () => {
    for (const { id, label } of CATEGORY_DICTIONARY) {
      const tags = deriveHashtags({ categoryIds: [id] });
      expect(tags.length, `category "${id}" (${label}) derives no hashtag`).toBeGreaterThan(0);
      expect(whitelisted(tags), `category "${id}" derives a non-whitelisted tag`).toBe(true);
    }
  });

  it("needs the season to be STATED — a coat on its own is not winter wear", () => {
    expect(deriveHashtags({ categoryIds: ["palto"] })).not.toContain("#Зимняяодежда");
    expect(deriveHashtags({ text: ["Зимняя одежда и пуховики"] })).toContain("#Зимняяодежда");
  });

  it("needs unisex to be STATED — an unmentioned gender is not unisex", () => {
    expect(deriveHashtags({ categoryIds: ["futbolki"] })).not.toContain("#Унисексодежда");
    expect(deriveHashtags({ text: ["унисекс худи и свитеры"] })).toContain("#Унисексодежда");
  });

  it("names each newly added garment category with its own tag first", () => {
    expect(deriveHashtags({ categoryIds: ["platya"] })[0]).toBe("#Платья");
    expect(deriveHashtags({ categoryIds: ["kurtki"] })[0]).toBe("#Куртки");
    expect(deriveHashtags({ categoryIds: ["svitery"] })[0]).toBe("#Свитеры");
    expect(deriveHashtags({ categoryIds: ["sportivnaya-odezhda"] })[0]).toBe("#Спортивнаяодежда");
  });

  it("keeps the taxonomy to clothing — no unrelated retail tags exist to pick", () => {
    for (const bad of ["#Авто", "#Электроника", "#Косметика", "#Цветы", "#Подарки"]) {
      expect(TELEGRAM_HASHTAG_LIST).not.toContain(bad);
    }
  });
});

/**
 * One audience tag plus a general garment tag — never the two fused into a
 * third. "#Женскаяодежда #Джинсы" says everything "#Женскиеджинсы" would, in
 * tags Telegram search already shares with every other shop.
 */
describe("hashtags stay short: one audience tag + a general garment tag", () => {
  const CASES: [name: string, text: string, expected: string[]][] = [
    ["women's jeans", "Женская одежда: джинсы", ["#Женскаяодежда", "#Джинсы"]],
    ["men's jeans", "Мужская одежда: джинсы", ["#Мужскаяодежда", "#Джинсы"]],
    ["women's T-shirts", "Женская одежда: футболки", ["#Женскаяодежда", "#Футболки"]],
    ["men's T-shirts", "Мужская одежда: футболки", ["#Мужскаяодежда", "#Футболки"]],
    ["unisex hoodies", "Унисекс худи", ["#Унисексодежда", "#Худи"]],
    ["women's sportswear", "Женская спортивная одежда", ["#Женскаяодежда", "#Спортивнаяодежда"]],
    [
      "men's winter jackets",
      "Мужская одежда. Куртки. Зимняя одежда",
      ["#Мужскаяодежда", "#Куртки", "#Зимняяодежда"],
    ],
  ];

  for (const [name, text, expected] of CASES) {
    it(`${name} → ${expected.join(" ")}`, () => {
      const tags = deriveHashtags({ text: [text] });
      expect(tags).toEqual(expect.arrayContaining(expected));
      expect(whitelisted(tags)).toBe(true);
      // Short by construction: two or three tags, not a wall of them.
      expect(tags.length).toBeLessThanOrEqual(4);
    });
  }

  it("offers no fused gender/sport/season product tag to pick in the first place", () => {
    const fused = TELEGRAM_HASHTAG_LIST.filter((tag) =>
      /^#(Женские|Мужские|Спортивные|Зимние|Теплые)/.test(tag),
    );
    expect(fused).toEqual([]);
  });

  it("never yields #Женскаяодежда + #Женскиеджинсы + #Джинсы", () => {
    const tags = deriveHashtags({ categoryIds: ["dzhinsy"], text: ["Женская одежда, джинсы"] });
    expect(tags).toContain("#Женскаяодежда");
    expect(tags).toContain("#Джинсы");
    expect(tags).not.toContain("#Женскиеджинсы");
  });
});
