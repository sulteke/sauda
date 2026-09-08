import { describe, expect, it } from "vitest";

import type { DetectedCategory } from "@/types/category";

import {
  applyCorrection,
  type CategoryDetectionInput,
  type CategoryDetectionStage,
  detectAutoCategories,
  type ImageCategoryClassifier,
  mergeCategories,
  noopImageClassifier,
  runCategoryPipeline,
} from "./category-pipeline";

const input = (biography: string | null): CategoryDetectionInput => ({
  biography,
  avatarUrl: null,
  posts: [],
});

const det = (id: string, label: string, score: number, matches: DetectedCategory["matches"] = []) =>
  ({ id, label, score, matches }) as DetectedCategory;

describe("detection stages", () => {
  it("noopImageClassifier detects nothing", async () => {
    await expect(noopImageClassifier.classify({ avatarUrl: null, imageUrls: [] })).resolves.toEqual(
      [],
    );
  });

  it("wires the keyword stage by default (image contributes nothing yet)", async () => {
    const auto = await detectAutoCategories(input("магазин: джинсы"));
    expect(auto.find((c) => c.id === "dzhinsy")?.score).toBe(5);
  });

  it("passes post images to an injected image classifier", async () => {
    const seen: string[] = [];
    const classifier: ImageCategoryClassifier = {
      name: "spy",
      async classify(inp) {
        seen.push(...inp.imageUrls);
        return [];
      },
    };
    await detectAutoCategories(
      {
        biography: null,
        avatarUrl: "a.jpg",
        posts: [
          { caption: null, hashtags: [], mentions: [], imageUrl: "p1.jpg" },
          { caption: null, hashtags: [], mentions: [], imageUrl: null },
        ],
      },
      { imageClassifier: classifier },
    );
    expect(seen).toEqual(["p1.jpg"]);
  });

  it("merges multiple stages by category (sums scores, concatenates evidence)", async () => {
    const keyword: CategoryDetectionStage = {
      name: "keyword",
      detect: () => [det("a", "A", 5, [{ keyword: "x", source: "biography", occurrences: 1, points: 5 }])],
    };
    const image: CategoryDetectionStage = {
      name: "image",
      detect: async () => [
        det("a", "A", 4, [{ keyword: "img", source: "caption", occurrences: 2, points: 4 }]),
        det("b", "B", 3),
      ],
    };
    const auto = await detectAutoCategories(input(null), { stages: [keyword, image] });
    const a = auto.find((c) => c.id === "a");
    expect(a?.score).toBe(9);
    expect(a?.matches).toHaveLength(2);
    expect(auto.map((c) => c.id)).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

describe("mergeCategories (Stage 3 overrides + provenance)", () => {
  const auto = [det("dzhinsy", "Джинсы", 8), det("obuv", "Обувь", 4)];

  it("returns all auto-detected with autoDetected=true when there are no overrides", () => {
    const result = mergeCategories(auto);
    expect(result.categories.map((c) => c.id)).toEqual(["dzhinsy", "obuv"]);
    expect(result.categories.every((c) => c.autoDetected && !c.manuallyAdded)).toBe(true);
  });

  it("drops manually-removed auto categories from the final list", () => {
    const result = mergeCategories(auto, { added: [], removed: ["obuv"] });
    expect(result.categories.map((c) => c.id)).toEqual(["dzhinsy"]);
  });

  it("appends manually-added categories with manuallyAdded=true", () => {
    const result = mergeCategories(auto, { added: ["sumki"], removed: [] });
    const sumki = result.categories.find((c) => c.id === "sumki");
    expect(sumki).toMatchObject({ id: "sumki", label: "Сумки", autoDetected: false, manuallyAdded: true, score: 0 });
    // Auto-detected come first, manual additions after.
    expect(result.categories[result.categories.length - 1]!.id).toBe("sumki");
  });

  it("ignores manual additions with an unknown id", () => {
    const result = mergeCategories(auto, { added: ["not-a-category"], removed: [] });
    expect(result.categories.map((c) => c.id)).toEqual(["dzhinsy", "obuv"]);
  });
});

describe("applyCorrection", () => {
  const autoIds = ["dzhinsy", "obuv"];

  it("records a manual add for a non-detected category", () => {
    expect(applyCorrection({ added: [], removed: [] }, autoIds, { add: ["sumki"] })).toEqual({
      added: ["sumki"],
      removed: [],
    });
  });

  it("records a manual remove for an auto-detected category", () => {
    expect(applyCorrection({ added: [], removed: [] }, autoIds, { remove: ["obuv"] })).toEqual({
      added: [],
      removed: ["obuv"],
    });
  });

  it("re-adding a removed auto category clears the removal", () => {
    expect(applyCorrection({ added: [], removed: ["obuv"] }, autoIds, { add: ["obuv"] })).toEqual({
      added: [],
      removed: [],
    });
  });

  it("removing a manually-added category drops the addition", () => {
    expect(applyCorrection({ added: ["sumki"], removed: [] }, autoIds, { remove: ["sumki"] })).toEqual(
      { added: [], removed: [] },
    );
  });
});

describe("runCategoryPipeline", () => {
  it("detects then merges with overrides in one call", async () => {
    const result = await runCategoryPipeline(input("джинсы и обувь"), {
      added: ["sumki"],
      removed: ["obuv"],
    });
    const ids = result.categories.map((c) => c.id);
    expect(ids).toContain("dzhinsy"); // auto, kept
    expect(ids).toContain("sumki"); // manual add
    expect(ids).not.toContain("obuv"); // auto, removed
  });
});
