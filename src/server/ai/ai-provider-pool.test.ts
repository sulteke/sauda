import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jobCount, cooldownFindMany, cooldownUpsert } = vi.hoisted(() => ({
  jobCount: vi.fn(),
  cooldownFindMany: vi.fn(),
  cooldownUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { count: jobCount },
    aiProviderCooldown: { findMany: cooldownFindMany, upsert: cooldownUpsert },
  },
}));

import { AiCategoryProviderError, type AiCategoryRequest } from "@/lib/ai-category-provider";

import {
  analyzeWithPool,
  anyProviderAvailable,
  configuredProviders,
  FALLBACK_PROVIDER_ID,
  NoProviderAvailableError,
  PRIMARY_PROVIDER_ID,
  providerUsage,
} from "./ai-provider-pool";

/**
 * The pool's whole job is deciding WHICH Google Cloud project runs and what to
 * do when one fails. Every case below is a failure mode seen in production:
 * a 429 when a project's daily quota is gone, a 503 when Gemini is overloaded,
 * a timeout, and a 400/403 that no second project would survive either.
 */

const ENV = [
  "GEMINI_API_KEY",
  "GEMINI_PRIMARY_API_KEY",
  "GEMINI_PRIMARY_PROJECT_ID",
  "GEMINI_FALLBACK_API_KEY",
  "GEMINI_FALLBACK_PROJECT_ID",
  "GEMINI_PRIMARY_DAILY_LIMIT",
  "GEMINI_FALLBACK_DAILY_LIMIT",
  "GEMINI_PROVIDER_COOLDOWN_MINUTES",
] as const;
const saved: Record<string, string | undefined> = {};

/** Both projects configured, as production is meant to be. */
function configureBothProjects() {
  process.env.GEMINI_PRIMARY_API_KEY = "key-a";
  process.env.GEMINI_PRIMARY_PROJECT_ID = "project-a";
  process.env.GEMINI_FALLBACK_API_KEY = "key-b";
  process.env.GEMINI_FALLBACK_PROJECT_ID = "project-b";
}

const request = (): AiCategoryRequest => ({
  businessName: "Qoima",
  username: "qoima",
  biography: "Худи и джинсы",
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  captions: [],
  hashtags: [],
  mentions: [],
  allowedCategories: [{ id: "hudi", label: "Худи" }],
});

/** A Gemini HTTP reply. */
const ok = () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"categories":[],"hashtags":[]}' }] } }],
      usageMetadata: {},
    }),
  }) as unknown as Response;

const httpError = (status: number) =>
  ({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    text: async () => `{"error":{"code":${status}}}`,
    json: async () => ({}),
  }) as unknown as Response;

/** Which key a request URL carried — the only way to tell the projects apart. */
const keyOf = (call: unknown[]) => (String(call[0]).includes("key-a") ? "A" : "B");

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  jobCount.mockReset();
  cooldownFindMany.mockReset();
  cooldownUpsert.mockReset();
  jobCount.mockResolvedValue(0);
  cooldownFindMany.mockResolvedValue([]);
  cooldownUpsert.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("two-project configuration", () => {
  it("builds primary and fallback from their own keys and projects", () => {
    configureBothProjects();
    const providers = configuredProviders();

    expect(providers.map((p) => p.id)).toEqual([PRIMARY_PROVIDER_ID, FALLBACK_PROVIDER_ID]);
    expect(providers.map((p) => p.projectId)).toEqual(["project-a", "project-b"]);
    // Each project carries its OWN limit — never a pooled total.
    expect(providers.map((p) => p.dailyLimit)).toEqual([20, 20]);
  });

  it("honors per-project daily limits independently", () => {
    configureBothProjects();
    process.env.GEMINI_PRIMARY_DAILY_LIMIT = "50";
    process.env.GEMINI_FALLBACK_DAILY_LIMIT = "5";

    expect(configuredProviders().map((p) => p.dailyLimit)).toEqual([50, 5]);
  });

  it("still works with only the legacy GEMINI_API_KEY as primary", () => {
    process.env.GEMINI_API_KEY = "legacy";
    const providers = configuredProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe(PRIMARY_PROVIDER_ID);
  });

  it("REFUSES a fallback in the same Google Cloud project, and says why", () => {
    configureBothProjects();
    process.env.GEMINI_FALLBACK_PROJECT_ID = "project-a"; // same project
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const providers = configuredProviders();

    // Quota is per project, so a second key inside it adds nothing.
    expect(providers.map((p) => p.id)).toEqual([PRIMARY_PROVIDER_ID]);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ai.pool.same_project");
    expect(logged).toContain("per PROJECT");
  });

  it("refuses a fallback that reuses the primary key", () => {
    process.env.GEMINI_PRIMARY_API_KEY = "same";
    process.env.GEMINI_FALLBACK_API_KEY = "same";
    expect(configuredProviders().map((p) => p.id)).toEqual([PRIMARY_PROVIDER_ID]);
  });

  it("has no providers at all when nothing is configured", () => {
    expect(configuredProviders()).toEqual([]);
  });
});

describe("failover between projects", () => {
  beforeEach(configureBothProjects);

  it("A succeeds → B is never called", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(PRIMARY_PROVIDER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyOf(fetchMock.mock.calls[0]!)).toBe("A");
    expect(cooldownUpsert).not.toHaveBeenCalled();
  });

  it("A 429 → B succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(fetchMock.mock.calls[0]!)).toBe("A");
    expect(keyOf(fetchMock.mock.calls[1]!)).toBe("B");
  });

  it("A 503 → B succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(503)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    expect((await analyzeWithPool(request())).providerId).toBe(FALLBACK_PROVIDER_ID);
  });

  it("A times out / network-errors → B succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    expect((await analyzeWithPool(request())).providerId).toBe(FALLBACK_PROVIDER_ID);
  });

  it("A 400 → B is NOT called (a bad request fails everywhere)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cooldownUpsert).not.toHaveBeenCalled(); // not the project's fault
  });

  it("A 403 → B is NOT called (a rejected key fails everywhere)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("A 429 + B 429 → the analysis fails (queue turns it into ANALYSIS_FAILED)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // A once, B once
    expect(cooldownUpsert).toHaveBeenCalledTimes(2); // both parked
  });

  it("spends at most ONE HTTP attempt per project — no internal retry, no A→B→A", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toThrow();

    // Exactly two calls total: one per project, each with its own key.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "B"]);
  });
});

describe("cooldown", () => {
  beforeEach(configureBothProjects);

  it("parks the failing project with the status that caused it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(ok()));

    await analyzeWithPool(request());

    const call = cooldownUpsert.mock.calls[0]?.[0] as {
      where: { provider: string };
      create: { lastStatus: number; cooldownUntil: Date };
    };
    expect(call.where).toEqual({ provider: PRIMARY_PROVIDER_ID });
    expect(call.create.lastStatus).toBe(429);
    expect(call.create.cooldownUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("uses the configured cooldown duration rather than a hardcoded one", async () => {
    process.env.GEMINI_PROVIDER_COOLDOWN_MINUTES = "30";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(httpError(503)).mockResolvedValueOnce(ok()));

    const before = Date.now();
    await analyzeWithPool(request());

    const { create } = cooldownUpsert.mock.calls[0]?.[0] as { create: { cooldownUntil: Date } };
    const minutes = (create.cooldownUntil.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30.1);
  });

  it("a cooled-down primary sends the NEXT boutique straight to the fallback", async () => {
    cooldownFindMany.mockResolvedValue([
      { provider: PRIMARY_PROVIDER_ID, cooldownUntil: new Date(Date.now() + 600_000) },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    // Primary was never even tried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyOf(fetchMock.mock.calls[0]!)).toBe("B");
  });

  it("an expired cooldown makes the primary available again", async () => {
    cooldownFindMany.mockResolvedValue([
      { provider: PRIMARY_PROVIDER_ID, cooldownUntil: new Date(Date.now() - 1000) },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    expect((await analyzeWithPool(request())).providerId).toBe(PRIMARY_PROVIDER_ID);
  });
});

describe("per-project daily budget", () => {
  beforeEach(configureBothProjects);

  it("counts each project separately, never as one pooled number", async () => {
    jobCount.mockImplementation(({ where }: { where: { analyzedBy: string } }) =>
      Promise.resolve(where.analyzedBy === PRIMARY_PROVIDER_ID ? 20 : 3),
    );

    const usage = await providerUsage();

    expect(usage).toMatchObject([
      { id: PRIMARY_PROVIDER_ID, used: 20, limit: 20, available: false },
      { id: FALLBACK_PROVIDER_ID, used: 3, limit: 20, available: true },
    ]);
  });

  it("an exhausted primary routes the next boutique directly to the fallback", async () => {
    jobCount.mockImplementation(({ where }: { where: { analyzedBy: string } }) =>
      Promise.resolve(where.analyzedBy === PRIMARY_PROVIDER_ID ? 20 : 0),
    );
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyOf(fetchMock.mock.calls[0]!)).toBe("B");
  });

  it("refuses when BOTH projects are spent, without calling either", async () => {
    jobCount.mockResolvedValue(20);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports availability for the queue's pre-check", async () => {
    jobCount.mockResolvedValue(20);
    expect(await anyProviderAvailable()).toMatchObject({ available: false });

    jobCount.mockResolvedValue(0);
    expect(await anyProviderAvailable()).toMatchObject({ available: true });
  });

  it("never blocks the queue when no AI is configured at all", async () => {
    for (const k of ENV) delete process.env[k];
    expect(await anyProviderAvailable()).toEqual({ available: true, usage: [] });
  });
});
