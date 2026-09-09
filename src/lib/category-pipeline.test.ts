import { describe, expect, it } from "vitest";

import type { DetectedCategory } from "@/types/category";

import { type AiCategoryProvider, type AiCategoryResult, EMPTY_AI_RESULT } from "./ai-category-provider";
import {
  applyCorrection,
  type CategoryDetectionInput,
  type CategoryDetectionStage,
  createAiCategoryStage,
  detectAutoCategories,
  type ImageCategoryClassifier,
  mergeCategories,
  noopImageClassifier,
  runCategoryPipeline,
  runHybridDetection,
} from "./category-pipeline";

/** Builds a fake AI provider returning a fixed result — no model involved. */
const fakeAiProvider = (result: Partial<AiCategoryResult>): AiCategoryProvider => ({
  name: "fake",
  async analyze() {
    return { ...EMPTY_AI_RESULT, ...result };
  },
});

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

describe("AI category stage", () => {
  it("keeps only allowed ids at or above the confidence threshold", async () => {
    const stage = createAiCategoryStage(
      fakeAiProvider({
        categories: [
          { id: "obuv", confidence: 80, reason: "sells shoes" }, // valid
          { id: "not-a-category", confidence: 95, reason: "invented" }, // invented → dropped
          { id: "hudi", confidence: 40, reason: "maybe" }, // below 60 → dropped
        ],
      }),
    );
    const result = await stage.detect(input("любой текст"));
    expect(result).toEqual([{ id: "obuv", label: "Обувь", score: 80, matches: [] }]);
  });

  it("the disabled provider (default) contributes nothing", async () => {
    const stage = createAiCategoryStage();
    expect(await stage.detect(input("магазин джинсов"))).toEqual([]);
  });

  it("merges AI results with the keyword stage via detectAutoCategories", async () => {
    // keyword finds dzhinsy (score 5); AI adds obuv (confidence 90).
    const auto = await detectAutoCategories(input("магазин джинсы"), {
      aiProvider: fakeAiProvider({ categories: [{ id: "obuv", confidence: 90, reason: "shoes" }] }),
    });
    const ids = auto.map((c) => c.id);
    expect(ids).toContain("dzhinsy");
    expect(ids).toContain("obuv");
    // AI's high-confidence obuv outranks the keyword dzhinsy.
    expect(auto[0]?.id).toBe("obuv");
    expect(auto.find((c) => c.id === "obuv")?.score).toBe(90);
  });

  it("receives the full text context (name, username, links) in the request", async () => {
    let seen: unknown;
    const provider: AiCategoryProvider = {
      name: "spy",
      async analyze(req) {
        seen = req;
        return { ...EMPTY_AI_RESULT };
      },
    };
    await createAiCategoryStage(provider).detect({
      biography: "bio",
      avatarUrl: null,
      businessName: "Qoima",
      username: "qoima",
      externalUrl: "https://qoima.asia",
      externalUrls: [{ title: null, url: "https://qoima.asia" }],
      businessAddress: null,
      posts: [{ caption: "new drop", hashtags: ["sale"], mentions: ["brand"], imageUrl: null }],
    });
    expect(seen).toMatchObject({
      businessName: "Qoima",
      username: "qoima",
      externalUrl: "https://qoima.asia",
      captions: ["new drop"],
      hashtags: ["sale"],
      mentions: ["brand"],
    });
    // Allowed categories are always provided so the model cannot invent ids.
    expect((seen as { allowedCategories: unknown[] }).allowedCategories.length).toBeGreaterThan(0);
    // Keyword results + enrichment are passed as prior context.
    expect(seen).toHaveProperty("keywordResults");
    expect(seen).toHaveProperty("enrichment");
  });
});

describe("runHybridDetection", () => {
  it("returns keyword, raw AI, and merged results separately from ONE AI call", async () => {
    let calls = 0;
    const provider: AiCategoryProvider = {
      name: "fake",
      async analyze() {
        calls += 1;
        return {
          ...EMPTY_AI_RESULT,
          categories: [{ id: "obuv", confidence: 92, reason: "sells shoes" }],
          city: "Алматы",
          priceSegment: "mid",
          style: "streetwear",
          summary: "Almaty sneaker shop",
        };
      },
    };

    const result = await runHybridDetection(input("магазин джинсы"), { aiProvider: provider });

    expect(calls).toBe(1); // exactly one AI call
    // Keyword result preserved on its own.
    expect(result.keyword.map((c) => c.id)).toContain("dzhinsy");
    // Raw AI result preserved in full (profiling fields included).
    expect(result.ai.city).toBe("Алматы");
    expect(result.ai.priceSegment).toBe("mid");
    expect(result.ai.categories[0]?.id).toBe("obuv");
    // Merged = keyword + validated AI.
    const mergedIds = result.autoDetected.map((c) => c.id);
    expect(mergedIds).toContain("dzhinsy");
    expect(mergedIds).toContain("obuv");
  });

  it("drops invented ids and low-confidence AI suggestions from the merge", async () => {
    const provider: AiCategoryProvider = {
      name: "fake",
      async analyze() {
        return {
          ...EMPTY_AI_RESULT,
          categories: [
            { id: "obuv", confidence: 80, reason: "ok" },
            { id: "not-real", confidence: 99, reason: "invented" },
            { id: "hudi", confidence: 20, reason: "weak" },
          ],
        };
      },
    };
    const result = await runHybridDetection(input(null), { aiProvider: provider });
    const ids = result.autoDetected.map((c) => c.id);
    expect(ids).toContain("obuv");
    expect(ids).not.toContain("not-real");
    expect(ids).not.toContain("hudi");
    // The raw AI result still records what the model said (pre-validation).
    expect(result.ai.categories).toHaveLength(3);
  });

  it("falls back to the disabled provider (keyword only) when none is given", async () => {
    const result = await runHybridDetection(input("магазин джинсы"));
    expect(result.ai.categories).toEqual([]);
    expect(result.autoDetected.map((c) => c.id)).toContain("dzhinsy");
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
