import { describe, expect, it } from "vitest";

import { CATEGORY_DICTIONARY } from "@/config/category-dictionary";

import {
  categoryLabel,
  detectCategories,
  type EngineConfig,
  resolveProductCategories,
  scoreCategories,
} from "./category-engine";

const empty = { biography: null, posts: [] };
const ids = (input: Parameters<typeof detectCategories>[0]) =>
  detectCategories(input).map((c) => c.id);

describe("scoreCategories", () => {
  it("returns one entry per dictionary category, in order", () => {
    const scored = scoreCategories(empty);
    expect(scored).toHaveLength(CATEGORY_DICTIONARY.length);
    expect(scored.map((c) => c.id)).toEqual(CATEGORY_DICTIONARY.map((c) => c.id));
    expect(scored.every((c) => c.score === 0 && c.matches.length === 0)).toBe(true);
  });

  it("weights each source: bio +5, hashtag +3, caption +2, mention +1", () => {
    const bio = scoreCategories({ biography: "джинс", posts: [] }).find((c) => c.id === "dzhinsy");
    expect(bio?.score).toBe(5);

    const withPosts = (post: { caption?: string; hashtags?: string[]; mentions?: string[] }) =>
      scoreCategories({
        biography: null,
        posts: [{ caption: post.caption ?? null, hashtags: post.hashtags ?? [], mentions: post.mentions ?? [] }],
      }).find((c) => c.id === "dzhinsy")?.score;

    expect(withPosts({ hashtags: ["джинсы"] })).toBe(3);
    expect(withPosts({ caption: "джинсы" })).toBe(2);
    expect(withPosts({ mentions: ["джинсы"] })).toBe(1);
  });

  it("records WHY a category scored: keyword, source, occurrences and points", () => {
    const [hoodie] = detectCategories({
      biography: "стильные худи",
      posts: [{ caption: "our hoodie is great", hashtags: ["hoodie"], mentions: [] }],
    }).filter((c) => c.id === "hudi");

    expect(hoodie).toBeTruthy();
    // 5 (bio: худи) + 3 (hashtag: hoodie) + 2 (caption: hoodie) = 10
    expect(hoodie!.score).toBe(10);
    // Strongest evidence first.
    expect(hoodie!.matches[0]).toMatchObject({
      keyword: "худи",
      source: "biography",
      occurrences: 1,
      points: 5,
    });
    expect(hoodie!.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "hoodie", source: "hashtag", points: 3 }),
        expect.objectContaining({ keyword: "hoodie", source: "caption", points: 2 }),
      ]),
    );
  });

  it("counts repeated occurrences", () => {
    const shoes = scoreCategories({
      biography: null,
      posts: [{ caption: "a shoe and another shoe", hashtags: [], mentions: [] }],
    }).find((c) => c.id === "obuv");
    const shoeMatch = shoes?.matches.find((m) => m.keyword === "shoe");
    expect(shoeMatch).toMatchObject({ occurrences: 2, source: "caption", points: 4 });
  });
});

describe("detectCategories", () => {
  it("returns nothing for empty input", () => {
    expect(detectCategories(empty)).toEqual([]);
  });

  it("assigns every category that reaches the threshold, richest-first", () => {
    const result = detectCategories({ biography: "джинсы джинсы худи", posts: [] });
    expect(result[0]?.id).toBe("dzhinsy");
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it("respects the threshold: one caption hit (+2) is below, two (+4) qualify", () => {
    expect(
      ids({ biography: null, posts: [{ caption: "летние шорты", hashtags: [], mentions: [] }] }),
    ).not.toContain("shorty");
    expect(
      ids({ biography: null, posts: [{ caption: "шорты и ещё шорты", hashtags: [], mentions: [] }] }),
    ).toContain("shorty");
  });

  it("matches inflections but not mid-word coincidences", () => {
    expect(ids({ biography: "джинсовые куртки", posts: [] })).toContain("dzhinsy");
    expect(ids({ biography: "цветочки на витрине", posts: [] })).not.toContain("ochki");
  });

  it("supports Russian, Kazakh and English keywords", () => {
    expect(ids({ biography: "sneakers and boots", posts: [] })).toContain("obuv");
    expect(ids({ biography: "мектеп формасы", posts: [] })).toContain("school");
  });
});

describe("extensibility: the engine runs on an injected dictionary", () => {
  it("uses a custom config with no knowledge of the default dictionary", () => {
    const config: EngineConfig = {
      dictionary: [{ id: "widgets", label: "Widgets", keywords: ["widget"] }],
      weights: { biography: 5, hashtag: 3, caption: 2, mention: 1 },
      threshold: 3,
    };
    const result = detectCategories({ biography: "premium widget shop", posts: [] }, config);
    expect(result).toEqual([
      { id: "widgets", label: "Widgets", score: 5, matches: [expect.objectContaining({ keyword: "widget" })] },
    ]);
    expect(categoryLabel("widgets", config)).toBe("Widgets");
    expect(resolveProductCategories(["widgets"], config)).toEqual([
      { id: "widgets", label: "Widgets" },
    ]);
  });
});

describe("resolveProductCategories", () => {
  it("maps ids to id+label in dictionary order and drops unknowns", () => {
    expect(resolveProductCategories(["dzhinsy", "nope", "futbolki"])).toEqual([
      { id: "futbolki", label: "Футболки" },
      { id: "dzhinsy", label: "Джинсы" },
    ]);
  });
});
