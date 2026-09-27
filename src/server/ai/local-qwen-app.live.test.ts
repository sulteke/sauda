import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOCAL ONLY — one real batch call to LM Studio on 127.0.0.1, with invented
 * shops and no database of any kind.
 *
 * The question it answers is the one mocked tests cannot: given our real batch
 * prompt and our real taxonomy, does a real local model come back with three
 * separate, well-formed answers our real parser accepts? Everything around
 * that is fake on purpose — the shops do not exist, nothing is read from the
 * queue, and nothing is written anywhere.
 *
 * Run it with:
 *   LOCAL_AI_APP_TEST=true LOCAL_AI_ENABLED=true \
 *     npx vitest run src/server/ai/local-qwen-app.live.test.ts
 *
 * It is skipped otherwise, so it never runs in the normal suite or in CI.
 *
 * Note on naming: vitest only collects `*.test.ts`, so the file is named for
 * what it is (a live app-level test) rather than `local-qwen.app-test.ts`,
 * which would never be picked up.
 */

const LIVE = process.env.LOCAL_AI_APP_TEST === "true";

/**
 * GUARD — Prisma is replaced by a proxy that throws on ANY access.
 *
 * This is the load-bearing safety net: if a single line of the path under test
 * reaches for the database, the test fails loudly instead of quietly touching
 * production Supabase.
 */
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `GUARD VIOLATION: Prisma was accessed (prisma.${String(prop)}). ` +
            "This test must never touch a database.",
        );
      },
    },
  ),
}));

import { CATEGORY_DICTIONARY } from "@/config/category-dictionary";
import { TELEGRAM_HASHTAG_LIST } from "@/config/telegram-hashtags";
import {
  type AiBatchItem,
  type AiCategoryRequest,
  supportsBatchAnalysis,
} from "@/lib/ai-category-provider";

import { configuredProviders, LOCAL_PROVIDER_ID } from "./ai-provider-pool";

/** Three invented shops, written to exercise the audience+garment hashtag rule. */
const SHOPS = [
  {
    handle: "demo_women_fashion",
    businessName: "Demo Women Fashion",
    biography: "Женская одежда. Джинсы, футболки, худи.",
    captions: ["Новые женские джинсы", "Базовые футболки", "Теплые худи"],
    hashtags: ["#женскаяодежда", "#джинсы", "#футболки", "#худи"],
  },
  {
    handle: "demo_men_store",
    businessName: "Demo Men Store",
    biography: "Мужская одежда. Джинсы, футболки, куртки.",
    captions: ["Мужские джинсы", "Новые футболки", "Зимние куртки"],
    hashtags: ["#мужскаяодежда", "#джинсы", "#футболки", "#куртки"],
  },
  {
    handle: "demo_unisex",
    businessName: "Demo Unisex Streetwear",
    biography: "Унисекс streetwear: худи, футболки и спортивная одежда.",
    captions: ["Новый oversized hoodie", "Unisex футболки", "Спортивная коллекция"],
    hashtags: ["#унисекс", "#худи", "#футболки"],
  },
] as const;

/** Built from the project's REAL taxonomy — no invented ids or tags. */
const toRequest = (shop: (typeof SHOPS)[number]): AiCategoryRequest => ({
  businessName: shop.businessName,
  username: shop.handle,
  biography: shop.biography,
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: [...shop.captions],
  hashtags: [...shop.hashtags],
  mentions: [],
  allowedCategories: CATEGORY_DICTIONARY.map(({ id, label }) => ({ id, label })),
  allowedHashtags: TELEGRAM_HASHTAG_LIST,
  keywordResults: [],
});

/** Credentials and connection strings removed, so reaching for them fails. */
const BLOCKED_ENV = [
  "DATABASE_URL",
  "DIRECT_URL",
  "GEMINI_API_KEY",
  "GEMINI_PRIMARY_API_KEY",
  "GEMINI_FALLBACK_API_KEY",
  "GEMINI_PRIMARY_PROJECT_ID",
  "GEMINI_FALLBACK_PROJECT_ID",
  "APIFY_TOKEN",
  "APIFY_2GIS_ACTOR",
] as const;
const saved: Record<string, string | undefined> = {};

const requests: string[] = [];
let realFetch: typeof fetch;

beforeEach(() => {
  for (const k of BLOCKED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LOCAL_AI_ENABLED = "true";

  requests.length = 0;
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    // GUARD — anything that is not the local model is a hard failure.
    if (!/127\.0\.0\.1|localhost/.test(url)) {
      throw new Error(`GUARD VIOLATION: outbound request to a non-local host: ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch);
});

afterEach(() => {
  for (const k of BLOCKED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe.skipIf(!LIVE)("LOCAL QWEN APP TEST — 3 invented shops, one real batch call", () => {
  it("analyzes all three in ONE request, through the real prompt and parser", async () => {
    // --- the pool builds exactly one provider, and it is the local one ---
    const providers = configuredProviders({ throwOnFailure: true });
    expect(providers.map((p) => p.id)).toEqual([LOCAL_PROVIDER_ID]);
    const entry = providers[0]!;
    expect(entry.metered).toBe(false); // draws on no Google allowance

    // The same capability check analyzeBatchWithPool makes, narrowing the type
    // so the call below needs no cast.
    const provider = entry.provider;
    if (!supportsBatchAnalysis(provider)) {
      throw new Error("the local provider must support batch analysis");
    }

    const items: AiBatchItem[] = SHOPS.map((s) => ({
      handle: s.handle,
      request: toRequest(s),
    }));

    const startedAt = Date.now();
    const batch = await provider.analyzeBatch(items);
    const durationMs = Date.now() - startedAt;

    // --- exactly ONE HTTP request, and it went to the local model ---
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("127.0.0.1:1234");
    expect(requests[0]).toContain("/v1/chat/completions");
    expect(requests.filter((u) => u.includes("googleapis.com"))).toHaveLength(0);
    expect(requests.filter((u) => u.includes("apify.com"))).toHaveLength(0);

    // --- every handle answered exactly once, none invented, none duplicated ---
    const answered = [...batch.results.keys(), ...batch.skipped.map((s) => s.handle)];
    const expectedHandles = SHOPS.map((s) => s.handle);
    expect(answered.slice().sort()).toEqual(expectedHandles.slice().sort());
    expect(new Set(answered).size).toBe(answered.length);

    // --- every category and hashtag belongs to the existing taxonomy ---
    const allowedIds = new Set(CATEGORY_DICTIONARY.map((c) => c.id));
    for (const [handle, result] of batch.results) {
      for (const c of result.categories) {
        expect(allowedIds.has(c.id), `${handle}: invented category id "${c.id}"`).toBe(true);
        expect(c.confidence).toBeGreaterThanOrEqual(0);
        expect(c.confidence).toBeLessThanOrEqual(100);
      }
      for (const tag of result.hashtags) {
        expect(
          TELEGRAM_HASHTAG_LIST.includes(tag),
          `${handle}: non-whitelist hashtag "${tag}"`,
        ).toBe(true);
      }
    }

    const line = (n: number, handle: string) => {
      const r = batch.results.get(handle);
      const skip = batch.skipped.find((s) => s.handle === handle);
      return (
        `\nSHOP ${n}:\n` +
        `  handle      : ${handle}\n` +
        (skip
          ? `  SKIPPED     : ${skip.reason}\n`
          : `  categories  : ${r!.categories.map((c) => `${c.id}(${c.confidence})`).join(", ") || "(none)"}\n` +
            `  hashtags    : ${r!.hashtags.join(" ") || "(none)"}\n` +
            `  summary     : ${(r!.summary ?? "null").slice(0, 140)}\n`)
      );
    };

    // eslint-disable-next-line no-console
    console.log(
      "\n===== LOCAL QWEN APP TEST =====\n" +
        `\nprovider: ${entry.id} (${entry.provider.name})\n` +
        `model:    ${entry.model}\n` +
        `duration: ${(durationMs / 1000).toFixed(1)}s\n` +
        SHOPS.map((s, i) => line(i + 1, s.handle)).join("") +
        `\nHTTP requests:\n` +
        `  Qwen:   ${requests.length}\n` +
        `  Gemini: ${requests.filter((u) => u.includes("googleapis.com")).length}\n` +
        `  Apify:  ${requests.filter((u) => u.includes("apify.com")).length}\n` +
        `  Database writes: 0 (Prisma proxy would have thrown)\n` +
        "\n================================\n",
    );
  }, 300_000);
});
