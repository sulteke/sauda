import { describe, expect, it } from "vitest";

import type { ProductCategory } from "@/types/category";

import {
  AI_CONFIDENCE_THRESHOLD,
  type AiCategoryRequest,
  buildAiCategoryPrompt,
  disabledAiCategoryProvider,
  EMPTY_AI_RESULT,
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
    await expect(disabledAiCategoryProvider.analyze(request())).resolves.toEqual(EMPTY_AI_RESULT);
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
    // Expanded schema + validate/extend instruction.
    expect(prompt).toContain("targetAudience");
    expect(prompt).toContain("priceSegment");
    expect(prompt).toContain("style");
    expect(prompt).toContain("Validate or EXTEND");
  });

  it("instructs the model to return ALL categories (multi-label), not just the dominant one", () => {
    const prompt = buildAiCategoryPrompt(request());
    expect(prompt).toContain("MULTI-LABEL");
    expect(prompt).toMatch(/return (every|all)/i);
    expect(prompt).toContain("even if it appears in only one post");
    expect(prompt).toContain("Do NOT collapse to just the most common category");
    expect(prompt).toContain("Sort the categories array by confidence, highest first");
    // Catalog framing + certainty-based confidence (not frequency).
    expect(prompt).toContain("PRODUCT CATALOG");
    expect(prompt).toContain("CERTAINTY that the business sells that category");
    expect(prompt).toContain("no evidence for it in ANY of the posts");
    expect(prompt).toMatch(/NOT how frequently it appears/i);
  });

  it("parseAiCategoryResult keeps ALL categories the model returns (no cap)", () => {
    const many = parseAiCategoryResult({
      categories: [
        { id: "obuv", confidence: 95, reason: "shoes" },
        { id: "sumki", confidence: 80, reason: "bags" },
        { id: "dzhinsy", confidence: 72, reason: "jeans" },
        { id: "futbolki", confidence: 61, reason: "tees" },
      ],
    });
    expect(many.categories.map((c) => c.id)).toEqual(["obuv", "sumki", "dzhinsy", "futbolki"]);
  });

  it("includes keyword-engine results as prior context", () => {
    const prompt = buildAiCategoryPrompt({
      ...request(),
      keywordResults: [{ id: "hudi", label: "Худи", score: 9, matches: [] }],
    });
    expect(prompt).toContain("Keyword engine results");
    expect(prompt).toContain("hudi (score 9)");
  });
});

describe("parseAiCategoryResult", () => {
  it("parses a strict JSON string incl. the profiling fields", () => {
    const json =
      '{"categories":[{"id":"hudi","confidence":80,"reason":"hoodies"}],"city":"Алматы","mall":null,"address":"Абая 89","targetAudience":"men 18-30","priceSegment":"mid","style":"streetwear","summary":"menswear"}';
    const result = parseAiCategoryResult(json);
    expect(result.categories).toEqual([{ id: "hudi", confidence: 80, reason: "hoodies" }]);
    expect(result.city).toBe("Алматы");
    expect(result.address).toBe("Абая 89");
    expect(result.mall).toBeNull();
    expect(result.targetAudience).toBe("men 18-30");
    expect(result.priceSegment).toBe("mid");
    expect(result.style).toBe("streetwear");
    expect(result.summary).toBe("menswear");
  });

  it("ignores unexpected extra fields", () => {
    const result = parseAiCategoryResult({ categories: [], city: "Астана", bogus: "x", extra: 1 });
    expect(result.city).toBe("Астана");
    expect(result).not.toHaveProperty("bogus");
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
    expect(parseAiCategoryResult("not json")).toEqual(EMPTY_AI_RESULT);
    expect(parseAiCategoryResult(42).categories).toEqual([]);
    expect(parseAiCategoryResult(null).categories).toEqual([]);
  });
});
