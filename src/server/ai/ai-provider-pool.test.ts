import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory stand-in for the request ledger. Each test runs at a single
 * instant, so rows are keyed by provider+model and the day is ignored —
 * everything else (the `used < limit` guard, the unique conflict on create)
 * behaves as Postgres does, because those are what the pool relies on.
 */
const { jobCount, cooldownFindMany, cooldownUpsert, ledger } = vi.hoisted(() => {
  const rows = new Map<string, { provider: string; model: string; day: string; used: number }>();
  const key = (provider: string, model: string) => `${provider}\u0000${model}`;
  type Where = { provider: string; model: string; day: string; used?: { lt: number } };

  const bump = async ({ where, data }: { where: Where; data: { used: { increment: number } } }) => {
    const row = rows.get(key(where.provider, where.model));
    if (!row) return { count: 0 };
    const limit = where.used?.lt;
    if (limit !== undefined && row.used >= limit) return { count: 0 };
    row.used += data.used.increment;
    return { count: 1 };
  };

  return {
    jobCount: vi.fn(),
    cooldownFindMany: vi.fn(),
    cooldownUpsert: vi.fn(),
    ledger: {
      rows,
      seed: (provider: string, model: string, used: number) =>
        rows.set(key(provider, model), { provider, model, day: "test", used }),
      client: {
        findMany: vi.fn(async ({ where }: { where: { OR: { provider: string; model: string }[] } }) =>
          [...rows.values()].filter((r) =>
            where.OR.some((p) => p.provider === r.provider && p.model === r.model),
          ),
        ),
        findUnique: vi.fn(async ({ where }: { where: { provider_model_day: Where } }) => {
          const w = where.provider_model_day;
          return rows.get(key(w.provider, w.model)) ?? null;
        }),
        updateMany: vi.fn(bump),
        create: vi.fn(async ({ data }: { data: { provider: string; model: string; day: string; used: number } }) => {
          const k = key(data.provider, data.model);
          if (rows.has(k)) throw new Error("unique constraint");
          rows.set(k, { ...data });
          return data;
        }),
        upsert: vi.fn(
          async ({
            where,
            update,
            create,
          }: {
            where: { provider_model_day: Where };
            update: { used: number };
            create: { provider: string; model: string; day: string; used: number };
          }) => {
            const w = where.provider_model_day;
            const k = key(w.provider, w.model);
            const existing = rows.get(k);
            if (existing) existing.used = update.used;
            else rows.set(k, { ...create });
            return rows.get(k)!;
          },
        ),
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { count: jobCount },
    aiProviderCooldown: { findMany: cooldownFindMany, upsert: cooldownUpsert },
    aiRequestLedger: ledger.client,
  },
}));

import { AiCategoryProviderError, type AiCategoryRequest } from "@/lib/ai-category-provider";

import { DEFAULT_GEMINI_MODEL, GeminiCategoryProvider } from "./gemini-category-provider";

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
 * do when one fails. Every case below is a failure mode seen in production: a
 * 429 when a project's daily quota is gone, a 503 when Gemini is overloaded, a
 * timeout, a 403 from a project Google has restricted pending billing, and a
 * 400 that no second project would survive either.
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
  "GEMINI_RETRY_DELAY_MS",
] as const;
const saved: Record<string, string | undefined> = {};

/** Both projects configured, as production is meant to be. */
function configureBothProjects() {
  process.env.GEMINI_PRIMARY_API_KEY = "key-a";
  process.env.GEMINI_PRIMARY_PROJECT_ID = "project-a";
  process.env.GEMINI_FALLBACK_API_KEY = "key-b";
  process.env.GEMINI_FALLBACK_PROJECT_ID = "project-b";
  // Retries are real here; only their WAITS are removed, so the tests exercise
  // the same attempt sequence production does without sleeping through it.
  process.env.GEMINI_RETRY_DELAY_MS = "0";
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

const httpError = (status: number, body = `{"error":{"code":${status}}}`) =>
  ({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    text: async () => body,
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
  ledger.rows.clear();
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

  it("A 429 → B succeeds, with NO retry wasted on A", async () => {
    // A rate limit belongs to the project: waiting on it burns the budget while
    // the other project sits idle, so the pool switches immediately.
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "B"]);
  });

  it("a 503 that clears on retry is served by A — B is never called", async () => {
    // The case that used to park BOTH projects for ten minutes over one blip.
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(503)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(PRIMARY_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "A"]);
    // Nothing was wrong with the project, so nothing is parked.
    expect(cooldownUpsert).not.toHaveBeenCalled();
  });

  it("A 503 that never clears → B succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "A", "A", "B"]);
  });

  it("the fallback retries its own transient failure before the run is lost", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(httpError(503))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "A", "A", "B", "B"]);
  });

  it("a timeout / network error is retried on A first, then falls over to B", async () => {
    const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(aborted())
      .mockRejectedValueOnce(aborted())
      .mockRejectedValueOnce(aborted())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "A", "A", "B"]);
  });

  it("A 400 → B is NOT called (a bad request fails everywhere)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cooldownUpsert).not.toHaveBeenCalled(); // not the project's fault
  });

  it("A 403 → B IS called: a restricted project says nothing about the other", async () => {
    // Regression: a fallback project in Google's "set up billing" restricted
    // state answered 403, and treating that as permanent aborted analyses the
    // healthy project could have finished.
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(403)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "B"]);
    // The rejected project is parked so the next boutique skips it.
    expect(cooldownUpsert).toHaveBeenCalledTimes(1);
  });

  it("A 401 → B IS called: a rejected key is that key's problem alone", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(401)).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    expect((await analyzeWithPool(request())).providerId).toBe(FALLBACK_PROVIDER_ID);
  });

  it("A 404 → B is NOT called (the model name is wrong everywhere)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cooldownUpsert).not.toHaveBeenCalled(); // not the project's fault
  });

  it("A 429 + B 429 → the analysis fails (queue turns it into ANALYSIS_FAILED)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(AiCategoryProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // A once, B once
    expect(cooldownUpsert).toHaveBeenCalledTimes(2); // both parked
  });

  it("hands each project the time actually left, capped so one cannot starve the next", async () => {
    // Regression: a fixed per-project budget cut a healthy fallback short
    // mid-flight ("This operation was aborted") even though the primary had
    // failed in under a second.
    const analyzeSpy = vi.spyOn(GeminiCategoryProvider.prototype, "analyze");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(ok()));

    await analyzeWithPool(request());

    const budgets = analyzeSpy.mock.calls.map((c) => (c[1] as { budgetMs: number }).budgetMs);
    expect(budgets).toHaveLength(2);
    // No project may take the whole request.
    expect(budgets[0]!).toBeLessThanOrEqual(28_000);
    // A 429 answers in under a second, so the fallback still gets a full-length
    // attempt plus room to retry — not the leftovers of a fixed split.
    expect(budgets[1]!).toBeGreaterThan(20_000);
  });

  it("retries each project in turn and never comes back — no A→B→A", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpError(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toThrow();

    // Each project gets its own retries, in order, exactly once.
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(["A", "A", "A", "B", "B", "B"]);
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(ok()),
    );

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

/**
 * The ledger counts what Google counts: requests SENT. A day that spends fifty
 * requests and produces five analyses must read as fifty, or we keep arguing
 * with a quota that is already gone.
 */
describe("request ledger — counts requests, not analyses", () => {
  beforeEach(configureBothProjects);

  const used = (provider: string) =>
    ledger.rows.get(`${provider}\u0000${DEFAULT_GEMINI_MODEL}`)?.used ?? 0;

  it("counts ONE slot for a request that succeeds first time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));

    await analyzeWithPool(request());

    expect(used(PRIMARY_PROVIDER_ID)).toBe(1);
    expect(used(FALLBACK_PROVIDER_ID)).toBe(0);
  });

  it("counts EVERY retry — three attempts spend three slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(ok()),
    );

    await analyzeWithPool(request());

    expect(used(PRIMARY_PROVIDER_ID)).toBe(3);
  });

  it("counts requests that FAILED — the old counter missed exactly these", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpError(503)));

    await expect(analyzeWithPool(request())).rejects.toThrow();

    // Three attempts on each project, all failed, all charged.
    expect(used(PRIMARY_PROVIDER_ID)).toBe(3);
    expect(used(FALLBACK_PROVIDER_ID)).toBe(3);
  });

  it("sends NOTHING once the allowance is spent mid-flight", async () => {
    // One slot left: the first attempt takes it, the retry cannot.
    ledger.seed(PRIMARY_PROVIDER_ID, DEFAULT_GEMINI_MODEL, 19);
    const fetchMock = vi.fn().mockResolvedValue(httpError(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toThrow();

    // Primary sent exactly one request, not three; the rest went to B.
    expect(fetchMock.mock.calls.filter((c) => keyOf(c) === "A")).toHaveLength(1);
    expect(used(PRIMARY_PROVIDER_ID)).toBe(20);
  });
});

describe("429 is two different failures", () => {
  beforeEach(configureBothProjects);

  /** A Google 429 body naming the quota that was exceeded. */
  const quotaBody = (scope: "PerMinute" | "PerDay") =>
    `{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequests${scope}PerProjectPerModel-FreeTier"}]}]}}`;

  it("per-DAY: burns the rest of the project's ledger and does not cool it down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(httpError(429, quotaBody("PerDay"))).mockResolvedValueOnce(ok()),
    );

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    // Spent for the day — a ten-minute cooldown could not bring it back.
    expect(ledger.rows.get(`${PRIMARY_PROVIDER_ID}\u0000${DEFAULT_GEMINI_MODEL}`)?.used).toBe(20);
    expect(cooldownUpsert).not.toHaveBeenCalled();
  });

  it("per-MINUTE: parks the project only briefly, keeping the day's allowance", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(httpError(429, quotaBody("PerMinute")))
        .mockResolvedValueOnce(ok()),
    );

    const before = Date.now();
    await analyzeWithPool(request());

    const { create } = cooldownUpsert.mock.calls[0]?.[0] as { create: { cooldownUntil: Date } };
    const seconds = (create.cooldownUntil.getTime() - before) / 1000;
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThanOrEqual(61); // ~60s, not the 10-minute default
  });

  it("an unlabelled 429 keeps the cautious default cooldown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(httpError(429, '{"error":{"code":429}}')).mockResolvedValueOnce(ok()),
    );

    const before = Date.now();
    await analyzeWithPool(request());

    const { create } = cooldownUpsert.mock.calls[0]?.[0] as { create: { cooldownUntil: Date } };
    const minutes = (create.cooldownUntil.getTime() - before) / 60_000;
    expect(minutes).toBeGreaterThan(9);
  });
});

describe("per-project daily budget", () => {
  beforeEach(configureBothProjects);

  /** Pretend this project has already SENT `used` requests today. */
  const spent = (provider: string, used: number) =>
    ledger.seed(provider, DEFAULT_GEMINI_MODEL, used);

  it("counts each project separately, never as one pooled number", async () => {
    spent(PRIMARY_PROVIDER_ID, 20);
    spent(FALLBACK_PROVIDER_ID, 3);

    const usage = await providerUsage();

    expect(usage).toMatchObject([
      { id: PRIMARY_PROVIDER_ID, used: 20, limit: 20, available: false },
      { id: FALLBACK_PROVIDER_ID, used: 3, limit: 20, available: true },
    ]);
  });

  it("an exhausted primary routes the next boutique directly to the fallback", async () => {
    spent(PRIMARY_PROVIDER_ID, 20);
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await analyzeWithPool(request());

    expect(outcome.providerId).toBe(FALLBACK_PROVIDER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyOf(fetchMock.mock.calls[0]!)).toBe("B");
  });

  it("refuses when BOTH projects are spent, without calling either", async () => {
    spent(PRIMARY_PROVIDER_ID, 20);
    spent(FALLBACK_PROVIDER_ID, 20);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeWithPool(request())).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports availability for the queue's pre-check", async () => {
    spent(PRIMARY_PROVIDER_ID, 20);
    spent(FALLBACK_PROVIDER_ID, 20);
    expect(await anyProviderAvailable()).toMatchObject({ available: false });

    ledger.rows.clear();
    expect(await anyProviderAvailable()).toMatchObject({ available: true });
  });

  it("never blocks the queue when no AI is configured at all", async () => {
    for (const k of ENV) delete process.env[k];
    expect(await anyProviderAvailable()).toEqual({ available: true, usage: [] });
  });
});
