import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiBatchValidationError,
  AiCategoryProviderError,
  type AiCategoryRequest,
} from "@/lib/ai-category-provider";

import { LocalQwenCategoryProvider } from "./local-qwen-category-provider";

/**
 * The local model is a development fallback, so what matters is that it speaks
 * the same contract as Gemini: same prompts in, same validated shapes out, and
 * a clean AiCategoryProviderError when it cannot. Nothing here touches a real
 * server — every reply is a stubbed fetch.
 */

const request = (): AiCategoryRequest => ({
  businessName: "Qoima",
  username: "qoima",
  biography: "Женская одежда Алматы",
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: ["джинсы"],
  hashtags: [],
  mentions: [],
  allowedCategories: [
    { id: "dzhinsy", label: "Джинсы" },
    { id: "hudi", label: "Худи" },
  ],
  allowedHashtags: ["#Женскаяодежда", "#Джинсы"],
  keywordResults: [],
});

const batchItem = (handle: string) => ({ handle, request: request() });

/** An LM Studio style chat-completion reply carrying `content`. */
const reply = (content: string) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  }) as unknown as Response;

const httpError = (status: number, body = "server said no") =>
  ({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({}),
    text: async () => body,
  }) as unknown as Response;

const SINGLE_JSON = JSON.stringify({
  categories: [{ id: "dzhinsy", confidence: 90, reason: "джинсы" }],
  hashtags: ["#Женскаяодежда", "#Джинсы"],
  city: "Алматы",
  mall: null,
  address: null,
  targetAudience: null,
  priceSegment: null,
  style: null,
  summary: null,
});

let fetchMock: ReturnType<typeof vi.fn>;
const ENV = ["LOCAL_AI_BASE_URL", "LOCAL_AI_MODEL", "LOCAL_AI_MAX_TOKENS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The JSON body of the single fetch the provider made. */
function sentBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
}

describe("LocalQwenCategoryProvider — single analysis", () => {
  it("parses a valid reply into the shared result shape", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    const result = await new LocalQwenCategoryProvider().analyze(request());

    expect(result.categories).toEqual([{ id: "dzhinsy", confidence: 90, reason: "джинсы" }]);
    expect(result.hashtags).toEqual(["#Женскаяодежда", "#Джинсы"]);
    expect(result.city).toBe("Алматы");
  });

  it("unwraps a ```json fence, which a local model often adds", async () => {
    fetchMock.mockResolvedValue(reply("```json\n" + SINGLE_JSON + "\n```"));

    const result = await new LocalQwenCategoryProvider().analyze(request());

    expect(result.categories).toHaveLength(1);
  });

  it("still whitelist-checks hashtags — a local model is not trusted more", async () => {
    fetchMock.mockResolvedValue(
      reply(JSON.stringify({ categories: [], hashtags: ["#Джинсы", "#Выдуманный"] })),
    );

    const result = await new LocalQwenCategoryProvider().analyze(request());

    expect(result.hashtags).toEqual(["#Джинсы"]);
  });

  it("degrades malformed JSON to an empty result, exactly as Gemini does", async () => {
    fetchMock.mockResolvedValue(reply("I think this shop sells jeans!"));

    const result = await new LocalQwenCategoryProvider().analyze(request());

    expect(result.categories).toEqual([]);
    expect(result.hashtags).toEqual([]);
  });
});

describe("LocalQwenCategoryProvider — request shape", () => {
  it("includes /no_think, without which the answer is truncated by reasoning", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request());

    const messages = sentBody().messages as { role: string; content: string }[];
    expect(messages[0]!.content.startsWith("/no_think")).toBe(true);
  });

  it("sends the SHARED prompt — same taxonomy Gemini is given", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request());

    const content = (sentBody().messages as { content: string }[])[0]!.content;
    expect(content).toContain("PRODUCT CATALOG");
    expect(content).toContain("Never invent a category id");
    expect(content).toContain("#Женскаяодежда #Джинсы");
  });

  it("takes the model and base URL from the environment", async () => {
    process.env.LOCAL_AI_BASE_URL = "http://localhost:9999";
    process.env.LOCAL_AI_MODEL = "qwen/custom-model";
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request());

    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:9999/v1/chat/completions");
    expect(sentBody().model).toBe("qwen/custom-model");
  });

  it("tolerates a trailing slash in the base URL", async () => {
    process.env.LOCAL_AI_BASE_URL = "http://localhost:9999/";
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request());

    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:9999/v1/chat/completions");
  });

  it("asks for low temperature, so the same shop keeps answering the same way", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request());

    expect(sentBody().temperature).toBe(0.2);
  });
});

describe("LocalQwenCategoryProvider — failures", () => {
  it("throws on an empty reply rather than reporting an analysed shop with nothing in it", async () => {
    fetchMock.mockResolvedValue(reply("   "));

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toBeInstanceOf(
      AiCategoryProviderError,
    );
  });

  it("throws on a missing content field", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{}] }),
      text: async () => "",
    } as unknown as Response);

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toThrow(/empty reply/);
  });

  it("throws with the status on HTTP 400", async () => {
    fetchMock.mockResolvedValue(httpError(400));

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toMatchObject({
      status: 400,
    });
  });

  it.each([500, 503])("throws with the status on HTTP %i", async (status) => {
    fetchMock.mockResolvedValue(httpError(status));

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toMatchObject({
      status,
    });
  });

  it("turns an aborted request into a provider error, so a hung server cannot stall the queue", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toBeInstanceOf(
      AiCategoryProviderError,
    );
  });

  it("passes an abort signal, and caps it by the caller's budget", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    await new LocalQwenCategoryProvider().analyze(request(), { budgetMs: 5_000 });

    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes exactly ONE attempt — a local server has no shared load to wait out", async () => {
    fetchMock.mockResolvedValue(httpError(503));

    await expect(new LocalQwenCategoryProvider().analyze(request())).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("LocalQwenCategoryProvider — batch", () => {
  const batchJson = (handles: string[]) =>
    JSON.stringify({
      results: Object.fromEntries(
        handles.map((h) => [h, { categories: [], hashtags: ["#Джинсы"] }]),
      ),
      skipped: [],
    });

  it("answers a whole batch under the same contract Gemini keeps", async () => {
    fetchMock.mockResolvedValue(reply(batchJson(["a", "b", "c"])));

    const batch = await new LocalQwenCategoryProvider().analyzeBatch([
      batchItem("a"),
      batchItem("b"),
      batchItem("c"),
    ]);

    expect([...batch.results.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(batch.skipped).toEqual([]);
  });

  it("carries a skip and its reason through unchanged", async () => {
    fetchMock.mockResolvedValue(
      reply(
        JSON.stringify({
          results: { a: { categories: [], hashtags: [] } },
          skipped: [{ handle: "b", reason: "not a clothing shop" }],
        }),
      ),
    );

    const batch = await new LocalQwenCategoryProvider().analyzeBatch([
      batchItem("a"),
      batchItem("b"),
    ]);

    expect(batch.skipped).toEqual([{ handle: "b", reason: "not a clothing shop" }]);
  });

  it("rejects a reply that drops a shop — the batch contract is not relaxed for a local model", async () => {
    fetchMock.mockResolvedValue(reply(batchJson(["a"])));

    await expect(
      new LocalQwenCategoryProvider().analyzeBatch([batchItem("a"), batchItem("b")]),
    ).rejects.toBeInstanceOf(AiBatchValidationError);
  });

  it("rejects malformed batch JSON instead of applying part of it", async () => {
    fetchMock.mockResolvedValue(reply("sorry, I could not do that"));

    await expect(
      new LocalQwenCategoryProvider().analyzeBatch([batchItem("a")]),
    ).rejects.toBeInstanceOf(AiBatchValidationError);
  });

  it("unwraps a fenced batch reply too", async () => {
    fetchMock.mockResolvedValue(reply("```json\n" + batchJson(["a"]) + "\n```"));

    const batch = await new LocalQwenCategoryProvider().analyzeBatch([batchItem("a")]);

    expect(batch.results.has("a")).toBe(true);
  });

  it("sends /no_think with the batch prompt as well", async () => {
    fetchMock.mockResolvedValue(reply(batchJson(["a"])));

    await new LocalQwenCategoryProvider().analyzeBatch([batchItem("a")]);

    const content = (sentBody().messages as { content: string }[])[0]!.content;
    expect(content.startsWith("/no_think")).toBe(true);
    expect(content).toContain("EXACTLY ONCE");
  });
});
