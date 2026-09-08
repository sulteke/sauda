import { describe, expect, it } from "vitest";

import {
  analyzeCategories,
  resolveProductCategories,
  SCORE_THRESHOLD,
} from "./category-analyzer";

const noPosts = { biography: null, posts: [] };
const ids = (input: Parameters<typeof analyzeCategories>[0]) =>
  analyzeCategories(input).map((c) => c.id);

describe("analyzeCategories", () => {
  it("returns nothing for empty input", () => {
    expect(analyzeCategories(noPosts)).toEqual([]);
  });

  it("detects multiple categories from the biography (weight 5 each)", () => {
    const result = ids({
      biography: "Магазин мужской одежды: футболки, рубашки, джинсы и обувь",
      posts: [],
    });
    expect(result).toEqual(expect.arrayContaining(["futbolki", "rubashki", "dzhinsy", "obuv"]));
  });

  it("weights sources: bio +5, hashtag +3, caption +2, mention +1", () => {
    const [bio] = analyzeCategories({ biography: "джинсы", posts: [] });
    expect(bio).toMatchObject({ id: "dzhinsy", score: 5 });

    const [hashtag] = analyzeCategories({
      biography: null,
      posts: [{ caption: null, hashtags: ["джинсы"], mentions: [] }],
    });
    expect(hashtag).toMatchObject({ id: "dzhinsy", score: 3 });
  });

  it("respects the threshold: one caption hit (+2) is below, two (+4) qualify", () => {
    expect(SCORE_THRESHOLD).toBe(3);
    expect(
      ids({ biography: null, posts: [{ caption: "летние шорты", hashtags: [], mentions: [] }] }),
    ).not.toContain("shorty");
    expect(
      ids({
        biography: null,
        posts: [{ caption: "шорты и ещё шорты", hashtags: [], mentions: [] }],
      }),
    ).toContain("shorty");
  });

  it("a single mention (+1) is below threshold", () => {
    expect(
      ids({ biography: null, posts: [{ caption: null, hashtags: [], mentions: ["джинсовый"] }] }),
    ).not.toContain("dzhinsy");
  });

  it("matches inflected forms but not mid-word coincidences", () => {
    // "джинсовые" -> stem "джинс"
    expect(ids({ biography: "джинсовые куртки", posts: [] })).toContain("dzhinsy");
    // "цветочки" must NOT trigger Очки ("очк")
    expect(ids({ biography: "цветочки на витрине", posts: [] })).not.toContain("ochki");
  });

  it("sorts detected categories richest-first", () => {
    const result = analyzeCategories({ biography: "джинсы джинсы худи", posts: [] });
    expect(result[0]?.id).toBe("dzhinsy");
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it("supports Kazakh and English keywords", () => {
    expect(ids({ biography: "sneakers and boots", posts: [] })).toContain("obuv");
    expect(ids({ biography: "мектеп формасы", posts: [] })).toContain("school");
  });
});

describe("resolveProductCategories", () => {
  it("maps ids to id+label in canonical order and drops unknowns", () => {
    expect(resolveProductCategories(["dzhinsy", "nope", "futbolki"])).toEqual([
      { id: "futbolki", label: "Футболки" },
      { id: "dzhinsy", label: "Джинсы" },
    ]);
  });

  it("returns [] for no ids", () => {
    expect(resolveProductCategories([])).toEqual([]);
  });
});
