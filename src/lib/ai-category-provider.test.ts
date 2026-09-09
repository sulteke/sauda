import { describe, expect, it } from "vitest";

import type { ProductCategory } from "@/types/category";

import {
  AI_CONFIDENCE_THRESHOLD,
  type AiCategoryRequest,
  buildAiCategoryPrompt,
  disabledAiCategoryProvider,
  getAiCategoryProvider,
  parseAiCategoryResult,
} from "./ai-category-provider";

const allowed: ProductCategory[] = [
  { id: "hudi", label: "Худи" },
  { id: "dzhinsy", label: "Джинсы" },
];

const request = (): AiCategoryRequest => ({
  businessName: "Qoima",
  username: "qoima",
  biography: "bio",
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: [],
  hashtags: [],
  mentions: [],
  allowedCategories: allowed,
});

describe("disabled AI provider", () => {
  it("is the default provider and contributes nothing", async () => {
    expect(getAiCategoryProvider()).toBe(disabledAiCategoryProvider);
    await expect(disabledAiCategoryProvider.analyze(request())).resolves.toEqual({
      categories: [],
      city: null,
      mall: null,
      address: null,
      summary: null,
    });
  });
});

describe("buildAiCategoryPrompt", () => {
  it("lists allowed ids, the schema and the hard rules", () => {
    const prompt = buildAiCategoryPrompt(request());
    expect(prompt).toContain("hudi");
    expect(prompt).toContain("Худи");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain(String(AI_CONFIDENCE_THRESHOLD));
    expect(prompt).toContain("Never invent");
    expect(prompt).toContain('"categories"');
  });
});

describe("parseAiCategoryResult", () => {
  it("parses a strict JSON string", () => {
    const json =
      '{"categories":[{"id":"hudi","confidence":80,"reason":"hoodies"}],"city":"Алматы","mall":null,"address":"Абая 89","summary":"menswear"}';
    const result = parseAiCategoryResult(json);
    expect(result.categories).toEqual([{ id: "hudi", confidence: 80, reason: "hoodies" }]);
    expect(result.city).toBe("Алматы");
    expect(result.address).toBe("Абая 89");
    expect(result.mall).toBeNull();
    expect(result.summary).toBe("menswear");
  });

  it("accepts an already-parsed object", () => {
    const result = parseAiCategoryResult({ categories: [{ id: "dzhinsy", confidence: 70 }] });
    expect(result.categories).toEqual([{ id: "dzhinsy", confidence: 70, reason: "" }]);
  });

  it("drops malformed entries and clamps confidence", () => {
    const result = parseAiCategoryResult({
      categories: [
        { id: "hudi", confidence: 150 }, // clamped to 100
        { id: "", confidence: 80 }, // no id → dropped
        { id: "dzhinsy", confidence: "high" }, // non-number → dropped
        { confidence: 90 }, // no id → dropped
        { id: "shorty", confidence: -5 }, // clamped to 0
      ],
    });
    expect(result.categories).toEqual([
      { id: "hudi", confidence: 100, reason: "" },
      { id: "shorty", confidence: 0, reason: "" },
    ]);
  });

  it("returns an empty result for malformed input", () => {
    expect(parseAiCategoryResult("not json")).toEqual({
      categories: [],
      city: null,
      mall: null,
      address: null,
      summary: null,
    });
    expect(parseAiCategoryResult(42).categories).toEqual([]);
    expect(parseAiCategoryResult(null).categories).toEqual([]);
  });
});
