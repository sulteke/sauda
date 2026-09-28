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

/** A reply the model was CUT OFF mid-sentence, as LM Studio reports it. */
const truncated = (content: string) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content }, finish_reason: "length" }] }),
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

  /**
   * REGRESSION — an 8B model that falls into repeating itself runs to the token
   * ceiling and the JSON is cut mid-object. The shared parser answers
   * unparseable text with an EMPTY result, so before this guard such a shop was
   * stored as analyzed successfully with no categories, no hashtags and no
   * summary, and nothing anywhere said it had failed.
   */
  it("throws when the reply was cut off at max_tokens, instead of storing an empty analysis", async () => {
    const cutOff = '{"categories":[{"id":"hudi","confidence":95,"reason":"Худи назван';
    fetchMock.mockResolvedValue(truncated(cutOff));

    const provider = new LocalQwenCategoryProvider();
    await expect(provider.analyze(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    await expect(provider.analyze(request())).rejects.toThrow(/cut off at max_tokens/i);
  });

  it("says how to fix a truncated reply, since the number is the whole problem", async () => {
    process.env.LOCAL_AI_MAX_TOKENS = "2048";
    fetchMock.mockResolvedValue(truncated("{"));

    const provider = new LocalQwenCategoryProvider();
    await expect(provider.analyze(request())).rejects.toThrow(/2048/);
    await expect(provider.analyze(request())).rejects.toThrow(/context length/i);
  });

  it("accepts a reply that finished normally, so the guard is not over-eager", async () => {
    fetchMock.mockResolvedValue(reply(SINGLE_JSON));

    const provider = new LocalQwenCategoryProvider();
    const result = await provider.analyze(request());
    expect(result.categories.map((c) => c.id)).toEqual(["dzhinsy"]);
  });

  /**
   * REGRESSION — the queue used to show a bare "400 Bad Request" for the single
   * most common local failure (a prompt longer than the model's context), and
   * the sentence that says so sat only in a server log.
   */
  it("carries the server's own explanation into the error, not just the status", async () => {
    const body = JSON.stringify({
      error:
        "The number of tokens to keep from the initial prompt is greater than the context length",
    });
    fetchMock.mockResolvedValue(httpError(400, body));

    const provider = new LocalQwenCategoryProvider();
    await expect(provider.analyze(request())).rejects.toThrow(/greater than the context length/);
  });

  it("falls back to raw text when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue(httpError(500, "model crashed"));

    const provider = new LocalQwenCategoryProvider();
    await expect(provider.analyze(request())).rejects.toThrow(/model crashed/);
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
