import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiCategoryProviderError, type AiCategoryRequest } from "@/lib/ai-category-provider";

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

/** A non-OK HTTP response with a readable error body. */
function errorResponse(status: number, body = `{"error":{"code":${status}}}`): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    text: async () => body,
    json: async () => ({}),
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

  it("never throws: returns an empty result on a non-OK response, and logs status + body at warn", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, '{"error":{"code":400,"message":"bad model"}}'));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 1,
    }).analyze(request());

    expect(result.categories).toEqual([]);
    expect(result.summary).toBeNull();
    // The real Google error (status + body) is logged at warn level (visible on Vercel).
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("gemini.request_failed");
    expect(warned).toContain('"status":400');
    expect(warned).toContain("bad model");
    expect(warned).not.toContain("k"); // never the api key
  });

  it("retries transient 503 and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiResponse('{"categories":[{"id":"hudi","confidence":90}]}'));

    const result = await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      retryDelayMs: 0,
    }).analyze(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.categories).toEqual([{ id: "hudi", confidence: 90, reason: "" }]);
  });

  it("gives up after maxAttempts of persistent 503", async () => {
    fetchMock.mockResolvedValue(errorResponse(503, "high demand"));

    const result = await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 3,
      retryDelayMs: 0,
    }).analyze(request());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.categories).toEqual([]);
  });

  it("does NOT retry a 429 — the rate limit is the project's, so the caller switches", async () => {
    fetchMock.mockResolvedValue(errorResponse(429, '{"error":{"code":429}}'));

    const result = await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 3,
    }).analyze(request());

    // One attempt only: waiting here would burn the budget while the OTHER
    // project — which has its own quota — sits idle.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.categories).toEqual([]);
  });

  /** Reads the waits the provider logged, in order. */
  function loggedWaits(warnSpy: { mock: { calls: unknown[][] } }): number[] {
    return warnSpy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { message: string; waitMs?: number })
      .filter((e) => e.message === "gemini.retrying")
      .map((e) => e.waitMs ?? -1);
  }

  it("backs off exponentially between 5xx retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // mid-spread: no net jitter
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(geminiResponse('{"categories":[]}'));

    await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 3,
      retryDelayMs: 100,
    }).analyze(request());

    expect(loggedWaits(warnSpy)).toEqual([100, 200]);
  });

  it("jitters each backoff, so parallel imports do not retry in lockstep", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // top of the ±25% spread
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(geminiResponse('{"categories":[]}'));

    await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 3,
      retryDelayMs: 100,
    }).analyze(request());

    // 100 → 125 and 200 → 250: the same curve, nudged off the shared beat.
    expect(loggedWaits(warnSpy)).toEqual([125, 250]);
  });

  it("throws in strict mode on a 429 (→ fallback project, then ANALYSIS_FAILED)", async () => {
    fetchMock.mockResolvedValue(errorResponse(429, '{"error":{"code":429}}'));

    await expect(
      new GeminiCategoryProvider("k", {
        baseUrl: "https://gemini.test",
        maxAttempts: 2,
        throwOnFailure: true,
      }).analyze(request()),
    ).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never throws: retries then returns an empty result on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 2,
      retryDelayMs: 0,
    }).analyze(request());
    expect(result.categories).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates malformed (non-JSON) model replies", async () => {
    fetchMock.mockResolvedValue(geminiResponse("oops not json"));
    const result = await new GeminiCategoryProvider("k", { baseUrl: "https://gemini.test" }).analyze(
      request(),
    );
    expect(result.categories).toEqual([]);
  });

  it("throwOnFailure: throws AiCategoryProviderError with the status on a terminal non-OK", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, '{"error":{"code":400}}'));

    const provider = new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 1,
      throwOnFailure: true,
    });

    await expect(provider.analyze(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    await expect(provider.analyze(request())).rejects.toMatchObject({ status: 400 });
  });

  it("throwOnFailure: throws after exhausting retries on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const provider = new GeminiCategoryProvider("k", {
      baseUrl: "https://gemini.test",
      maxAttempts: 2,
      retryDelayMs: 0,
      throwOnFailure: true,
    });

    await expect(provider.analyze(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
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
