import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOCAL ONLY — one real batch call to LM Studio, asking a single question:
 * does the local model move confidence with the STRENGTH of the evidence, or
 * does it just echo whatever number the worked examples happened to use?
 *
 * The previous run answered three shops with 95 across the board, but every
 * one of those shops named its products outright — so a flat 95 was not
 * obviously wrong. These three are built to separate the cases: one states its
 * range plainly, one hedges every claim, and one says nothing concrete at all.
 * If confidence is a judgement, the three should not look alike.
 *
 * Run it with:
 *   LOCAL_AI_CONFIDENCE_TEST=true LOCAL_AI_ENABLED=true \
 *     npx vitest run src/server/ai/local-qwen-confidence.live.test.ts
 *
 * Skipped otherwise. No database, no Gemini, no Apify — see the guards below.
 */

const LIVE = process.env.LOCAL_AI_CONFIDENCE_TEST === "true";

/** GUARD — any database access at all fails the test loudly. */
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

/**
 * Three shops that differ ONLY in how strongly they support their categories.
 * Same taxonomy, same shape — the variable under test is the evidence.
 */
const SHOPS = [
  {
    label: "STRONG",
    handle: "weak_test_strong",
    businessName: "Strong Evidence Shop",
    biography: "Женская одежда. В продаже джинсы, футболки, худи.",
    captions: ["Новая коллекция джинсов", "Футболки уже в наличии", "Худи разных размеров"],
  },
  {
    label: "MEDIUM",
    handle: "weak_test_medium",
    businessName: "Medium Evidence Shop",
    biography: "Магазин одежды для женщин.",
    captions: [
      "Иногда бывают джинсы",
      "Показывали одну модель худи",
      "Основной ассортимент постоянно меняется",
    ],
  },
  {
    label: "WEAK",
    handle: "weak_test_weak",
    businessName: "Weak Evidence Shop",
    biography: "Магазин одежды.",
    captions: ["Сегодня новая коллекция", "Образ дня", "Новинки уже в магазине"],
  },
] as const;

const toRequest = (shop: (typeof SHOPS)[number]): AiCategoryRequest => ({
  businessName: shop.businessName,
  username: shop.handle,
  biography: shop.biography,
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: [...shop.captions],
  hashtags: [],
  mentions: [],
  allowedCategories: CATEGORY_DICTIONARY.map(({ id, label }) => ({ id, label })),
  allowedHashtags: TELEGRAM_HASHTAG_LIST,
  keywordResults: [],
});

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
let promptChars = 0;
let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
let realFetch: typeof fetch;

beforeEach(() => {
  for (const k of BLOCKED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LOCAL_AI_ENABLED = "true";

  requests.length = 0;
  promptChars = 0;
  usage = {};
  realFetch = globalThis.fetch;

  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (!/127\.0\.0\.1|localhost/.test(url)) {
      throw new Error(`GUARD VIOLATION: outbound request to a non-local host: ${url}`);
    }
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as { messages?: { content: string }[] };
      promptChars = body.messages?.[0]?.content.length ?? 0;
    }
    const response = await realFetch(input, init);
    // Read the token counts from a clone, leaving the real body untouched.
    try {
      const seen = (await response.clone().json()) as { usage?: typeof usage };
      if (seen.usage) usage = seen.usage;
    } catch {
      /* not JSON — the provider will report the failure itself */
    }
    return response;
  }) as typeof fetch);
});

afterEach(() => {
  for (const k of BLOCKED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe.skipIf(!LIVE)("LOCAL QWEN — does confidence track evidence strength?", () => {
  it("answers three shops of differing evidence in ONE request", async () => {
    const providers = configuredProviders({ throwOnFailure: true });
    expect(providers.map((p) => p.id)).toEqual([LOCAL_PROVIDER_ID]);
    const entry = providers[0]!;
    const provider = entry.provider;
    if (!supportsBatchAnalysis(provider)) throw new Error("local provider must support batch");

    const items: AiBatchItem[] = SHOPS.map((s) => ({ handle: s.handle, request: toRequest(s) }));

    const startedAt = Date.now();
    const batch = await provider.analyzeBatch(items);
    const durationMs = Date.now() - startedAt;

    // --- invariants: these must hold whatever the model decided ---
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("127.0.0.1:1234");
    expect(requests.filter((u) => u.includes("googleapis.com"))).toHaveLength(0);
    expect(requests.filter((u) => u.includes("apify.com"))).toHaveLength(0);

    const answered = [...batch.results.keys(), ...batch.skipped.map((s) => s.handle)];
    expect(answered.slice().sort()).toEqual(SHOPS.map((s) => s.handle).slice().sort());
    expect(new Set(answered).size).toBe(answered.length);

    const allowedIds = new Set(CATEGORY_DICTIONARY.map((c) => c.id));
    for (const [handle, r] of batch.results) {
      for (const c of r.categories) {
        expect(allowedIds.has(c.id), `${handle}: invented id "${c.id}"`).toBe(true);
      }
      for (const tag of r.hashtags) {
        expect(TELEGRAM_HASHTAG_LIST.includes(tag), `${handle}: bad tag "${tag}"`).toBe(true);
      }
    }

    // --- the actual question, reported rather than asserted: we want to SEE
    // what the model did, not fail the run when it disappoints. ---
    const all: number[] = [];
    const perShop = SHOPS.map((s) => {
      const r = batch.results.get(s.handle);
      const skip = batch.skipped.find((x) => x.handle === s.handle);
      const confs = r ? r.categories.map((c) => c.confidence) : [];
      all.push(...confs);
      return { ...s, r, skip, confs };
    });
    const distinct = [...new Set(all)].sort((a, b) => b - a);

    const block = perShop
      .map(
        (s) =>
          `\n${s.label} — ${s.handle}\n` +
          (s.skip
            ? `  SKIPPED    : ${s.skip.reason}\n`
            : `  categories : ${s.r!.categories.map((c) => `${c.id}(${c.confidence})`).join(", ") || "(none)"}\n` +
              `  hashtags   : ${s.r!.hashtags.join(" ") || "(none)"}\n` +
              `  summary    : ${(s.r!.summary ?? "null").slice(0, 120)}\n` +
              `  avg conf   : ${s.confs.length ? (s.confs.reduce((a, b) => a + b, 0) / s.confs.length).toFixed(1) : "n/a"}\n`),
      )
      .join("");

    // eslint-disable-next-line no-console
    console.log(
      "\n===== LOCAL QWEN — CONFIDENCE CALIBRATION =====\n" +
        `\nmodel    : ${entry.model}\n` +
        `duration : ${(durationMs / 1000).toFixed(1)}s\n` +
        `prompt   : ${promptChars} chars, ${usage.prompt_tokens ?? "?"} tokens\n` +
        `output   : ${usage.completion_tokens ?? "?"} tokens\n` +
        block +
        `\nDISTINCT CONFIDENCE VALUES USED: ${distinct.join(", ") || "(none)"}\n` +
        `CALIBRATED (more than one value): ${distinct.length > 1 ? "YES" : "NO — every category got the same number"}\n` +
        `\nHTTP: Qwen ${requests.length} · Gemini 0 · Apify 0 · DB writes 0\n` +
        "\n===============================================\n",
    );
  }, 300_000);
});
