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
  AiBatchValidationError,
  buildAiBatchPrompt,
  parseAiBatchResult,
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

describe("hashtags in the AI contract", () => {
  it("asks for no hashtags, and keeps the schema unchanged, without a whitelist", () => {
    const prompt = buildAiCategoryPrompt(request());
    expect(prompt).not.toContain("Allowed hashtags");
    // The profile's own Instagram hashtags are still passed as input data; what
    // must be absent is the hashtags OUTPUT field.
    expect(prompt).not.toContain('"hashtags":["#Tag"');
  });

  it("lists the allowed hashtags and the no-inventing rule when a whitelist is supplied", () => {
    const prompt = buildAiCategoryPrompt({
      ...request(),
      allowedHashtags: ["#Худи", "#Кроссовки"],
    });
    expect(prompt).toContain("Allowed hashtags");
    expect(prompt).toContain("#Худи");
    expect(prompt).toContain("#Кроссовки");
    expect(prompt).toContain("NEVER invent");
    expect(prompt).toContain('"hashtags"');
    // Hashtags are a separate field, not folded into the categories.
    expect(prompt).toContain("SEPARATE field");
  });

  it("keeps only whitelisted hashtags from the model reply", () => {
    const result = parseAiCategoryResult(
      '{"categories":[],"hashtags":["#Худи","#ЧтоТоВыдуманное","кроссовки"]}',
    );
    expect(result.hashtags).toEqual(["#Худи", "#Кроссовки"]);
  });

  it("defaults hashtags to an empty array when the model omits or mangles them", () => {
    expect(parseAiCategoryResult('{"categories":[]}').hashtags).toEqual([]);
    expect(parseAiCategoryResult('{"categories":[],"hashtags":"#Худи"}').hashtags).toEqual([]);
    expect(parseAiCategoryResult("not json").hashtags).toEqual([]);
    expect(EMPTY_AI_RESULT.hashtags).toEqual([]);
  });

  it("caps the reply at five hashtags", () => {
    const result = parseAiCategoryResult({
      categories: [],
      hashtags: ["#Худи", "#Футболки", "#Джинсы", "#Обувь", "#Кроссовки", "#Кеды"],
    });
    expect(result.hashtags).toHaveLength(5);
  });
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

/**
 * A batch reply is only usable if every shop can be matched to its answer with
 * certainty. These are the ways that can fail; each one must reject the whole
 * reply rather than persist a plausible mix-up.
 */
describe("parseAiBatchResult — validation", () => {
  const ok = (handles: string[]) =>
    JSON.stringify({
      results: Object.fromEntries(handles.map((h) => [h, { categories: [], hashtags: [] }])),
      skipped: [],
    });

  it("accepts a reply that answers for every handle", () => {
    const batch = parseAiBatchResult(ok(["a", "b"]), ["a", "b"]);
    expect([...batch.results.keys()].sort()).toEqual(["a", "b"]);
    expect(batch.skipped).toEqual([]);
  });

  it("accepts a mix of results and skips, and keeps the reason", () => {
    const batch = parseAiBatchResult(
      JSON.stringify({
        results: { a: { categories: [], hashtags: [] } },
        skipped: [{ handle: "b", reason: "not a clothing shop" }],
      }),
      ["a", "b"],
    );
    expect(batch.results.has("a")).toBe(true);
    expect(batch.skipped).toEqual([{ handle: "b", reason: "not a clothing shop" }]);
  });

  it("matches handles ignoring case and a leading @", () => {
    const batch = parseAiBatchResult(
      JSON.stringify({ results: { "@Qoima": { categories: [], hashtags: [] } }, skipped: [] }),
      ["qoima"],
    );
    // Stored under the handle WE submitted, whatever the model echoed.
    expect(batch.results.has("qoima")).toBe(true);
  });

  it("rejects a missing handle — silence is not an answer", () => {
    expect(() => parseAiBatchResult(ok(["a"]), ["a", "b"])).toThrow(AiBatchValidationError);
  });

  it("rejects a handle that appears in BOTH results and skipped", () => {
    const raw = JSON.stringify({
      results: { a: { categories: [], hashtags: [] } },
      skipped: [{ handle: "a", reason: "unclear" }],
    });
    expect(() => parseAiBatchResult(raw, ["a"])).toThrow(/BOTH/);
  });

  it("rejects a duplicate skipped handle", () => {
    const raw = JSON.stringify({
      results: {},
      skipped: [
        { handle: "a", reason: "x" },
        { handle: "a", reason: "y" },
      ],
    });
    expect(() => parseAiBatchResult(raw, ["a"])).toThrow(/more than once/);
  });

  it("rejects a handle we never sent", () => {
    expect(() => parseAiBatchResult(ok(["a", "zzz"]), ["a"])).toThrow(/unknown handle/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAiBatchResult("{not json", ["a"])).toThrow(/not valid JSON/);
  });

  it("rejects a result entry that is not an object", () => {
    const raw = JSON.stringify({ results: { a: "hoodies" }, skipped: [] });
    expect(() => parseAiBatchResult(raw, ["a"])).toThrow(/not an object/);
  });

  it("rejects a missing results object", () => {
    expect(() => parseAiBatchResult(JSON.stringify({ skipped: [] }), ["a"])).toThrow(/"results"/);
  });

  it("still whitelist-checks hashtags inside a batch entry", () => {
    const raw = JSON.stringify({
      results: { a: { categories: [], hashtags: ["#Джинсы", "#ВыдуманныйТег"] } },
      skipped: [],
    });
    const batch = parseAiBatchResult(raw, ["a"]);
    expect(batch.results.get("a")!.hashtags).toEqual(["#Джинсы"]);
  });
});

describe("buildAiBatchPrompt", () => {
  const item = (handle: string) => ({
    handle,
    request: {
      businessName: handle,
      username: handle,
      biography: "Женская одежда",
      externalUrl: null,
      externalUrls: [],
      businessAddress: null,
      captions: [],
      hashtags: [],
      mentions: [],
      allowedCategories: [{ id: "dzhinsy", label: "Джинсы" }],
      allowedHashtags: ["#Женскаяодежда", "#Джинсы"],
      keywordResults: [],
    } as never,
  });

  it("names every handle and demands each appears exactly once", () => {
    const prompt = buildAiBatchPrompt([item("a"), item("b"), item("c")]);
    expect(prompt).toContain("- a");
    expect(prompt).toContain("- b");
    expect(prompt).toContain("- c");
    expect(prompt).toContain("EXACTLY ONCE");
    expect(prompt).toContain('"results"');
    expect(prompt).toContain('"skipped"');
  });

  it("carries the SAME taxonomy rules the single prompt uses", () => {
    const prompt = buildAiBatchPrompt([item("a")]);
    // The audience+garment rule that defines our hashtag style must be present,
    // or a batch would be free to invent a different one.
    expect(prompt).toContain("#Женскаяодежда #Джинсы");
    expect(prompt).toContain("PRODUCT CATALOG");
    expect(prompt).toContain("Never invent a category id");
  });

  it("tells the model the shops are unrelated", () => {
    expect(buildAiBatchPrompt([item("a"), item("b")])).toContain("Never let one shop's");
  });
});
