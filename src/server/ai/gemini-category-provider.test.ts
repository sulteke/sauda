import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiCategoryRequest } from "@/lib/ai-category-provider";

import {
  DEFAULT_GEMINI_MODEL,
  GeminiCategoryProvider,
  resolveAiCategoryProvider,
} from "./gemini-category-provider";

const request = (): AiCategoryRequest => ({
  businessName: "Qoima",
  username: "qoima",
  biography: "Мужская одежда Алматы",
  externalUrl: "https://qoima.asia",
  externalUrls: [{ title: null, url: "https://qoima.asia" }],
  businessAddress: null,
  captions: ["new hoodie drop"],
  hashtags: ["худи"],
  mentions: [],
  allowedCategories: [
    { id: "hudi", label: "Худи" },
    { id: "dzhinsy", label: "Джинсы" },
  ],
  keywordResults: [{ id: "hudi", label: "Худи", score: 9, matches: [] }],
});

/** Wraps a Gemini-style JSON reply in the API envelope. */
function geminiResponse(modelJson: string, usage?: Record<string, number>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: modelJson }] } }],
      usageMetadata: usage ?? { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    }),
  } as unknown as Response;
}

describe("GeminiCategoryProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a text-only JSON request to the model and parses the reply", async () => {
    fetchMock.mockResolvedValue(
      geminiResponse(
        '{"categories":[{"id":"hudi","confidence":88,"reason":"hoodies"}],"city":"Алматы","mall":null,"address":null,"targetAudience":"men","priceSegment":"mid","style":"street","summary":"s"}',
      ),
    );

    const provider = new GeminiCategoryProvider("secret-key", {
      baseUrl: "https://gemini.test",
      model: "gemini-test",
    });
    const result = await provider.analyze(request());

    // Endpoint targets the configured model.
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/v1beta/models/gemini-test:generateContent");

    // Body asks for JSON and contains the prompt (text only — no image fields).
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const promptText = body.contents[0].parts[0].text as string;
    expect(promptText).toContain("Never invent");
    expect(promptText).toContain("hudi");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("image");

    // Parsed result.
    expect(result.categories).toEqual([{ id: "hudi", confidence: 88, reason: "hoodies" }]);
    expect(result.city).toBe("Алматы");
    expect(result.priceSegment).toBe("mid");
  });

  it("logs model, tokens, time and provider — but NEVER the api key", async () => {
    fetchMock.mockResolvedValue(geminiResponse('{"categories":[]}'));

    await new GeminiCategoryProvider("super-secret-key", { baseUrl: "https://gemini.test" }).analyze(
      request(),
    );

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("gemini.request_ok");
    expect(logged).toContain('"model"');
    expect(logged).toContain('"totalTokens":120');
    expect(logged).toContain('"durationMs"');
    expect(logged).not.toContain("super-secret-key");
  });

  it("never throws: returns an empty result on a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as unknown as Response);

    const result = await new GeminiCategoryProvider("k", { baseUrl: "https://gemini.test" }).analyze(
      request(),
    );
    expect(result.categories).toEqual([]);
    expect(result.summary).toBeNull();
  });

  it("never throws: returns an empty result on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await new GeminiCategoryProvider("k", { baseUrl: "https://gemini.test" }).analyze(
      request(),
    );
    expect(result.categories).toEqual([]);
  });

  it("tolerates malformed (non-JSON) model replies", async () => {
    fetchMock.mockResolvedValue(geminiResponse("oops not json"));
    const result = await new GeminiCategoryProvider("k", { baseUrl: "https://gemini.test" }).analyze(
      request(),
    );
    expect(result.categories).toEqual([]);
  });
});

describe("resolveAiCategoryProvider", () => {
  const original = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  });

  it("returns the disabled provider when GEMINI_API_KEY is missing", () => {
    delete process.env.GEMINI_API_KEY;
    expect(resolveAiCategoryProvider().name).toBe("disabled");
  });

  it("returns the Gemini provider when GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    expect(resolveAiCategoryProvider().name).toBe("gemini");
  });

  it("exposes a default Flash model", () => {
    expect(DEFAULT_GEMINI_MODEL).toMatch(/flash/i);
  });
});
