import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOCAL ONLY — this file makes a REAL HTTP call to LM Studio on 127.0.0.1.
 *
 * It is skipped unless LOCAL_AI_LIVE_TEST=true, so it never runs in the normal
 * suite, in CI, or on anyone else's machine. It exists to answer one question
 * the mocked tests cannot: does a real local model, given our real prompt,
 * actually come back with something our real parser accepts?
 *
 * Run it with:
 *   LOCAL_AI_LIVE_TEST=true LOCAL_AI_ENABLED=true npx vitest run src/server/ai/local-qwen.live.test.ts
 *
 * Nothing else is real. Prisma is mocked, so no database is touched; the Gemini
 * keys are removed, so the pool has only the local provider to choose and no
 * Gemini request is even possible. Exactly ONE inference call is made.
 */

const LIVE = process.env.LOCAL_AI_LIVE_TEST === "true";

/** Prisma is mocked wholesale: any call here is a test failure, not a DB write. */
const { cooldownFindMany, cooldownUpsert, ledgerFindMany, ledgerCreate, ledgerUpdateMany } =
  vi.hoisted(() => ({
    cooldownFindMany: vi.fn(async () => []),
    cooldownUpsert: vi.fn(),
    ledgerFindMany: vi.fn(async () => []),
    ledgerCreate: vi.fn(),
    ledgerUpdateMany: vi.fn(async () => ({ count: 0 })),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiProviderCooldown: { findMany: cooldownFindMany, upsert: cooldownUpsert },
    aiRequestLedger: {
      findMany: ledgerFindMany,
      findUnique: vi.fn(),
      create: ledgerCreate,
      updateMany: ledgerUpdateMany,
      upsert: vi.fn(),
    },
    importJob: { count: vi.fn(async () => 0) },
  },
}));

import { CATEGORY_DICTIONARY } from "@/config/category-dictionary";
import { TELEGRAM_HASHTAG_LIST } from "@/config/telegram-hashtags";
import type { AiCategoryRequest } from "@/lib/ai-category-provider";

import { analyzeWithPool, configuredProviders, LOCAL_PROVIDER_ID } from "./ai-provider-pool";

/** A realistic womenswear shop, built from the project's own taxonomy. */
const storeRequest = (): AiCategoryRequest => ({
  businessName: "Test Women's Fashion Store",
  username: "testfashion",
  biography: "Женская одежда, джинсы, футболки и худи",
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: [],
  hashtags: [],
  mentions: [],
  allowedCategories: CATEGORY_DICTIONARY.map(({ id, label }) => ({ id, label })),
  allowedHashtags: TELEGRAM_HASHTAG_LIST,
  keywordResults: [],
});

const GEMINI_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_PRIMARY_API_KEY",
  "GEMINI_FALLBACK_API_KEY",
  "GEMINI_PRIMARY_PROJECT_ID",
  "GEMINI_FALLBACK_PROJECT_ID",
] as const;
const saved: Record<string, string | undefined> = {};

/** Records every outgoing request while still performing it for real. */
const calls: { url: string; body: Record<string, unknown> }[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
});

beforeEach(() => {
  // Remove every Gemini credential: with none configured the pool cannot build
  // a Gemini entry at all, so "it went local" is structural, not luck.
  for (const k of GEMINI_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LOCAL_AI_ENABLED = "true";
  calls.length = 0;

  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return realFetch(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  for (const k of GEMINI_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (!LIVE) {
    // eslint-disable-next-line no-console
    console.log(
      "\n[LOCAL ONLY] skipped. To run:\n" +
        "  LOCAL_AI_LIVE_TEST=true LOCAL_AI_ENABLED=true npx vitest run src/server/ai/local-qwen.live.test.ts\n",
    );
  }
});

describe.skipIf(!LIVE)("LOCAL ONLY — real LM Studio call through the pool", () => {
  it("routes one analysis to local Qwen and comes back with usable taxonomy", async () => {
    // --- the pool has exactly one provider, and it is the local one ---
    const ids = configuredProviders().map((p) => p.id);
    expect(ids).toEqual([LOCAL_PROVIDER_ID]);

    const startedAt = Date.now();
    const outcome = await analyzeWithPool(storeRequest());
    const durationMs = Date.now() - startedAt;

    // --- exactly ONE call, and it went to the local server ---
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("127.0.0.1:1234");
    expect(call.url).toContain("/v1/chat/completions");
    expect(call.body.model).toBe(process.env.LOCAL_AI_MODEL ?? "qwen/qwen3-8b");
    expect(call.body.temperature).toBe(0.2);

    const prompt = (call.body.messages as { content: string }[])[0]!.content;
    expect(prompt.startsWith("/no_think")).toBe(true);
    // The SAME prompt Gemini receives — not a local variant.
    expect(prompt).toContain("PRODUCT CATALOG");
    expect(prompt).toContain("Never invent a category id");

    // --- the pool attributed it to the local provider ---
    expect(outcome.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(outcome.providerName).toBe("local-qwen");

    // --- the parsed result obeys the existing taxonomy ---
    const allowedIds = new Set(CATEGORY_DICTIONARY.map((c) => c.id));
    for (const c of outcome.result.categories) {
      expect(allowedIds.has(c.id), `invented category id: ${c.id}`).toBe(true);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(100);
    }
    for (const tag of outcome.result.hashtags) {
      expect(TELEGRAM_HASHTAG_LIST.includes(tag), `non-whitelist hashtag: ${tag}`).toBe(true);
    }

    // --- no Gemini quota was reserved and no row was written ---
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(ledgerUpdateMany).not.toHaveBeenCalled();
    expect(cooldownUpsert).not.toHaveBeenCalled();

    // eslint-disable-next-line no-console
    console.log(
      "\n===== LOCAL QWEN LIVE RESULT =====\n" +
        `duration      : ${durationMs} ms\n` +
        `provider      : ${outcome.providerId} (${outcome.providerName})\n` +
        `model         : ${String(call.body.model)}\n` +
        `categories    : ${outcome.result.categories.map((c) => `${c.id}:${c.confidence}`).join(", ") || "(none)"}\n` +
        `hashtags      : ${outcome.result.hashtags.join(" ") || "(none)"}\n` +
        `city / mall   : ${outcome.result.city ?? "null"} / ${outcome.result.mall ?? "null"}\n` +
        `summary       : ${(outcome.result.summary ?? "null").slice(0, 120)}\n` +
        "==================================\n",
    );
  }, 180_000);
});
