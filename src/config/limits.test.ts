import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  analysisBatchSize,
  DEFAULT_ANALYSIS_BATCH_SIZE,
  DEFAULT_LOCAL_AI_MAX_TOKENS,
  DEFAULT_LOCAL_AI_TIMEOUT_MS,
  localAiMaxTokens,
  localAiOnly,
  localAiTimeoutMs,
} from "./limits";

/**
 * These are the numbers that decide how much a run costs and whether it fits,
 * so the ones that differ between production and a laptop are pinned here.
 */

const ENV = [
  "ANALYSIS_BATCH_SIZE",
  "LOCAL_AI_ENABLED",
  "LOCAL_AI_ONLY",
  "LOCAL_AI_TIMEOUT_MS",
  "LOCAL_AI_MAX_TOKENS",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The environment a deployed request runs in: no local model anywhere. */
function productionEnv() {
  delete process.env.LOCAL_AI_ENABLED;
  delete process.env.LOCAL_AI_ONLY;
}

/** A laptop running the local model as the whole pool. */
function localOnlyEnv() {
  process.env.LOCAL_AI_ENABLED = "true";
  process.env.LOCAL_AI_ONLY = "true";
}

describe("analysisBatchSize", () => {
  it("batches THREE in production — a request is the scarce thing there", () => {
    productionEnv();
    expect(analysisBatchSize()).toBe(DEFAULT_ANALYSIS_BATCH_SIZE);
    expect(analysisBatchSize()).toBe(3);
  });

  it("still honours ANALYSIS_BATCH_SIZE in production", () => {
    productionEnv();
    process.env.ANALYSIS_BATCH_SIZE = "5";
    expect(analysisBatchSize()).toBe(5);
  });

  /**
   * REGRESSION — three real shops build a ~21k-character prompt (20 posts of
   * captions each), which overflows an 8k context window and fails all three
   * with a 400 before a single one is analyzed. Batching buys nothing locally:
   * the local model has no request allowance to conserve.
   */
  it("drops to ONE when the local model is the whole pool", () => {
    localOnlyEnv();
    expect(localAiOnly()).toBe(true);
    expect(analysisBatchSize()).toBe(1);
  });

  it("ignores ANALYSIS_BATCH_SIZE when local-only — context, not config, is the limit", () => {
    localOnlyEnv();
    process.env.ANALYSIS_BATCH_SIZE = "3";
    expect(analysisBatchSize()).toBe(1);
  });

  /**
   * This asserted the opposite — that a pool with BOTH models kept batching,
   * on the reasoning that Gemini runs first and batching protects its quota.
   * Running it proved that wrong: a batch shares one prompt, so it is routed as
   * one, and three shops together are over the size limit almost every time.
   * Every shop went to Gemini, the local model never ran, and Gemini timed out
   * and cooled down — with eight shops failing behind it.
   */
  it("drops to ONE whenever the local model is in the pool at all", () => {
    process.env.LOCAL_AI_ENABLED = "true";
    expect(localAiOnly()).toBe(false); // not local-ONLY: Gemini is there too
    // One shop per request is what lets each be routed on its own size.
    expect(analysisBatchSize()).toBe(1);
  });
});

describe("localAiMaxTokens", () => {
  it("reserves modest room for the answer — the window is shared with the prompt", () => {
    // Every token promised to the answer is one the profile cannot use, and a
    // one-shop answer needs well under a thousand.
    expect(localAiMaxTokens()).toBe(DEFAULT_LOCAL_AI_MAX_TOKENS);
    expect(localAiMaxTokens()).toBeLessThanOrEqual(2048);
  });

  it("is tunable for a model loaded with a bigger context", () => {
    process.env.LOCAL_AI_MAX_TOKENS = "4096";
    expect(localAiMaxTokens()).toBe(4096);
  });
});

describe("localAiTimeoutMs", () => {
  it("defaults high enough for a model that answers in a minute or more", () => {
    expect(localAiTimeoutMs()).toBe(DEFAULT_LOCAL_AI_TIMEOUT_MS);
    expect(localAiTimeoutMs()).toBeGreaterThan(60_000);
  });

  it("is tunable, so a slower machine needs no code change", () => {
    process.env.LOCAL_AI_TIMEOUT_MS = "240000";
    expect(localAiTimeoutMs()).toBe(240_000);
  });

  it("falls back to the default on a value that is not a positive number", () => {
    process.env.LOCAL_AI_TIMEOUT_MS = "nonsense";
    expect(localAiTimeoutMs()).toBe(DEFAULT_LOCAL_AI_TIMEOUT_MS);
  });
});
