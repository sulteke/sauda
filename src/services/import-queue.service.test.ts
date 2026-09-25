import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findUnique, findMany, update, updateMany, deleteMany, count } = vi.hoisted(
  () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  }),
);

/** ImportJob reads: the parsed profile (quality gate) and today's AI calls. */
const { jobFindUnique, jobCount } = vi.hoisted(() => ({
  jobFindUnique: vi.fn(),
  jobCount: vi.fn(),
}));

/** Boutique reads: the duplicate guard, which must run before any scrape. */
const { boutiqueFindFirst, boutiqueFindMany, queueCreateMany } = vi.hoisted(() => ({
  boutiqueFindFirst: vi.fn(),
  boutiqueFindMany: vi.fn(),
  queueCreateMany: vi.fn(),
}));

const { parseInstagramProfile, analyzeImportJob } = vi.hoisted(() => ({
  parseInstagramProfile: vi.fn(),
  analyzeImportJob: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importQueue: {
      findFirst,
      findUnique,
      findMany,
      update,
      updateMany,
      deleteMany,
      count,
      createMany: queueCreateMany,
    },
    importJob: { findUnique: jobFindUnique, count: jobCount },
    boutique: { findFirst: boutiqueFindFirst, findMany: boutiqueFindMany },
  },
}));

vi.mock("@/services/import.service", () => ({ parseInstagramProfile, analyzeImportJob }));

// Provider availability is the pool's job and is covered in its own test file;
// here it is a dial, so the queue's reaction to "no capacity" can be exercised.
const { anyProviderAvailable, analyzeBatchWithPool } = vi.hoisted(() => ({
  anyProviderAvailable: vi.fn(),
  analyzeBatchWithPool: vi.fn(),
}));
vi.mock("@/server/ai/ai-provider-pool", () => ({ anyProviderAvailable, analyzeBatchWithPool }));

// The Analyze stage now sends a BATCH: it prepares each job, makes one pooled
// call, then applies each result. Those three are seams here; their own
// behaviour lives in the pipeline and pool tests.
const { prepareAnalysisJob, applyAnalysisResult, markAnalysisJobFailed } = vi.hoisted(() => ({
  prepareAnalysisJob: vi.fn(),
  applyAnalysisResult: vi.fn(),
  markAnalysisJobFailed: vi.fn(),
}));
vi.mock("@/server/import/import-pipeline", () => ({
  prepareAnalysisJob,
  applyAnalysisResult,
  markAnalysisJobFailed,
}));

/** An empty AI result, enough for the queue to treat a shop as analyzed. */
const aiResult = () => ({
  categories: [],
  hashtags: [],
  city: null,
  mall: null,
  address: null,
  targetAudience: null,
  priceSegment: null,
  style: null,
  summary: null,
});

import {
  addUrlsToQueue,
  clearQueue,
  deleteQueueItem,
  processNextImport,
  requeueStaleJobs,
  retryQueueItem,
} from "./import-queue.service";

function resetAll() {
  for (const fn of [
    findFirst,
    findUnique,
    findMany,
    update,
    updateMany,
    deleteMany,
    count,
    jobFindUnique,
    jobCount,
    boutiqueFindFirst,
    boutiqueFindMany,
    queueCreateMany,
  ]) {
    fn.mockReset();
  }
  // Default: nothing imported yet, so the duplicate guard lets work through.
  boutiqueFindFirst.mockResolvedValue(null);
  boutiqueFindMany.mockResolvedValue([]);
  parseInstagramProfile.mockReset();
  analyzeImportJob.mockReset();
  for (const fn of [analyzeBatchWithPool, prepareAnalysisJob, applyAnalysisResult, markAnalysisJobFailed])
    fn.mockReset();
  // findMany serves two callers now: stale recovery and picking the analyze
  // batch. Default both to empty; tests opt in with pendingAnalysis().
  findMany.mockResolvedValue([]);
  // Default batch seams: one job in, one analyzed result out.
  prepareAnalysisJob.mockImplementation((jobId: string) =>
    Promise.resolve({
      jobId,
      handle: `h-${jobId}`,
      rawProfile: {},
      prepared: { keyword: [], enrichment: {}, request: {} },
    }),
  );
  applyAnalysisResult.mockResolvedValue({ boutiqueId: "b1" });
  markAnalysisJobFailed.mockResolvedValue(undefined);
  // By default the model answers for every shop it was given.
  analyzeBatchWithPool.mockImplementation((items: { handle: string }[]) =>
    Promise.resolve({
      batch: { results: new Map(items.map((i) => [i.handle, aiResult()])), skipped: [] },
      providerId: "primary",
      providerName: "gemini",
    }),
  );
  updateMany.mockResolvedValue({ count: 0 });
  findFirst.mockResolvedValue(null);
  count.mockResolvedValue(0);
  // Default parsed profile clears the quality gate; no AI calls used today.
  jobFindUnique.mockResolvedValue({ rawProfile: { followersCount: 50_000 } });
  jobCount.mockResolvedValue(0);
  anyProviderAvailable.mockResolvedValue({
    available: true,
    usage: [{ id: "primary", projectId: "proj-a", used: 0, limit: 20, cooldownUntil: null, available: true }],
  });
  update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "row",
      instagramUrl: "https://instagram.com/x",
      status: data.status,
      error: data.error ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
}

describe("requeueStaleJobs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAll();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("does nothing (and never writes) when no in-flight job is stale", async () => {
    const count_ = await requeueStaleJobs();

    expect(count_).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
      "queue.stale_job_detected",
    );
  });

  it("reverts a stale PARSING job to PENDING_PARSE (re-scrape) and logs", async () => {
    const stuckAt = new Date(Date.now() - 11 * 60 * 1000);
    findMany.mockImplementation(({ where }: { where: { status: string } }) =>
      where.status === "PARSING"
        ? Promise.resolve([{ id: "a", instagramUrl: "https://instagram.com/a", updatedAt: stuckAt }])
        : Promise.resolve([]),
    );
    updateMany.mockResolvedValue({ count: 1 });

    const total = await requeueStaleJobs();
    expect(total).toBe(1);

    // Queries PARSING jobs older than the 10-min threshold and flips them to PENDING_PARSE.
    const call = updateMany.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === "PENDING_PARSE",
    );
    expect(call?.[0]).toMatchObject({
      where: { status: "PARSING" },
      data: { status: "PENDING_PARSE" },
    });
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "queue.stale_job_detected",
    );
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("queue.job_requeued");
  });

  it("reverts a stale ANALYZING job to PENDING_ANALYSIS (re-analyze only, no re-scrape)", async () => {
    const stuckAt = new Date(Date.now() - 11 * 60 * 1000);
    findMany.mockImplementation(({ where }: { where: { status: string } }) =>
      where.status === "ANALYZING"
        ? Promise.resolve([{ id: "b", instagramUrl: "https://instagram.com/b", updatedAt: stuckAt }])
        : Promise.resolve([]),
    );
    updateMany.mockResolvedValue({ count: 1 });

    const total = await requeueStaleJobs();
    expect(total).toBe(1);
    const call = updateMany.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === "PENDING_ANALYSIS",
    );
    expect(call?.[0]).toMatchObject({
      where: { status: "ANALYZING" },
      data: { status: "PENDING_ANALYSIS" },
    });
  });
});

describe("processNextImport", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns not-processed when nothing is actionable", async () => {
    const result = await processNextImport();
    expect(result).toEqual({ processed: false, item: null, remaining: 0 });
    expect(parseInstagramProfile).not.toHaveBeenCalled();
    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
  });

  it("parses the oldest PENDING_PARSE item (Apify only) and hands off to PENDING_ANALYSIS", async () => {
    // First findFirst (PENDING_ANALYSIS) → none; second (PENDING_PARSE) → a row.
    findFirst.mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
    parseInstagramProfile.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });
    count.mockResolvedValue(0);

    const result = await processNextImport();

    expect(parseInstagramProfile).toHaveBeenCalledWith({
      url: "https://instagram.com/p1",
      userId: null,
    });
    expect(analyzeBatchWithPool).not.toHaveBeenCalled(); // no Gemini in the parse stage
    // Marked PARSING then handed straight off to PENDING_ANALYSIS, linked to the ImportJob.
    expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { status: "PARSING" } });
    expect(update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { status: "PENDING_ANALYSIS", importJobId: "job-1", error: null },
    });
    expect(result.processed).toBe(true);
  });

  it("prioritises analysis: analyzes a PENDING_ANALYSIS item via its linked job (no Apify)", async () => {
    pendingAnalysis([{ id: "a1", instagramUrl: "https://instagram.com/a1", importJobId: "job-9" }]);

    const result = await processNextImport();

    expect(prepareAnalysisJob).toHaveBeenCalledWith("job-9");
    expect(analyzeBatchWithPool).toHaveBeenCalledTimes(1);
    expect(applyAnalysisResult).toHaveBeenCalledTimes(1);
    expect(parseInstagramProfile).not.toHaveBeenCalled(); // never re-scrapes during analysis
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1"] } },
      data: { status: "ANALYZING" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "READY_FOR_REVIEW", error: null },
    });
    expect(result.processed).toBe(true);
  });

  it("marks PARSE_FAILED when Apify fails, without touching analysis", async () => {
    findFirst.mockResolvedValueOnce({ id: "p2", instagramUrl: "https://instagram.com/p2", importJobId: null });
    parseInstagramProfile.mockRejectedValue(new Error("Apify timed out"));

    await processNextImport();

    expect(update).toHaveBeenCalledWith({
      where: { id: "p2" },
      data: { status: "PARSE_FAILED", error: "Apify timed out" },
    });
    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
  });

  it("marks ANALYSIS_FAILED when Gemini fails, leaving the parsed data intact (no re-scrape)", async () => {
    pendingAnalysis([{ id: "a2", instagramUrl: "https://instagram.com/a2", importJobId: "job-7" }]);
    analyzeBatchWithPool.mockRejectedValue(new Error("Gemini 503"));

    await processNextImport();

    expect(update).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: { status: "ANALYSIS_FAILED", error: "Gemini 503" },
    });
    expect(parseInstagramProfile).not.toHaveBeenCalled();
  });
});

/** Queues one PENDING_ANALYSIS row whose parsed profile has this follower count. */
function pendingAnalysisWith(followersCount: unknown) {
  pendingAnalysis([{ id: "q1", instagramUrl: "https://instagram.com/q1", importJobId: "job-1" }]);
  jobFindUnique.mockResolvedValue({ rawProfile: { followersCount } });
}

/** Queue these rows as the PENDING_ANALYSIS batch; stale recovery still sees none. */
function pendingAnalysis(rows: { id: string; instagramUrl: string; importJobId: string | null }[]) {
  findMany.mockImplementation(({ where }: { where: { status: string } }) =>
    Promise.resolve(where.status === "PENDING_ANALYSIS" ? rows : []),
  );
}

describe("follower quality gate", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("4,999 followers: never calls the AI and lands in terminal SKIPPED_LOW_FOLLOWERS", async () => {
    pendingAnalysisWith(4_999);

    const result = await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: expect.stringContaining("4,999") },
    });
    // Never marked ANALYZING — the gate runs before any state transition.
    expect(update).not.toHaveBeenCalledWith({ where: { id: "q1" }, data: { status: "ANALYZING" } });
    expect(result.processed).toBe(true);
  });

  it("exactly 5,000 followers qualifies: the AI IS called", async () => {
    pendingAnalysisWith(5_000);
    analyzeImportJob.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });

    await processNextImport();

    expect(analyzeBatchWithPool).toHaveBeenCalledTimes(1);
  });

  it("10,000 followers qualifies: the AI IS called", async () => {
    pendingAnalysisWith(10_000);
    analyzeImportJob.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });

    await processNextImport();

    expect(analyzeBatchWithPool).toHaveBeenCalledTimes(1);
  });

  it("skips conservatively when the follower count is unavailable (null)", async () => {
    pendingAnalysisWith(null);

    await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: "Skipped: follower count unavailable." },
    });
  });

  it("keeps an unparsed job retryable (ANALYSIS_FAILED) instead of skipping it", async () => {
    pendingAnalysis([{ id: "q1", instagramUrl: "https://instagram.com/q1", importJobId: "job-1" }]);
    jobFindUnique.mockResolvedValue({ rawProfile: null });
    prepareAnalysisJob.mockRejectedValue(new Error("Import job has not been parsed yet"));

    await processNextImport();

    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "ANALYSIS_FAILED", error: "Import job has not been parsed yet" },
    });
  });
});

/** Every project spent / cooling down — the pool reports no capacity. */
function exhaustAllProviders() {
  anyProviderAvailable.mockResolvedValue({
    available: false,
    usage: [
      { id: "primary", projectId: "proj-a", used: 20, limit: 20, cooldownUntil: null, available: false },
      { id: "fallback", projectId: "proj-b", used: 20, limit: 20, cooldownUntil: null, available: false },
    ],
  });
}

describe("daily analysis limit", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows the 20th AI call of the day", async () => {
    pendingAnalysisWith(50_000);
    jobCount.mockResolvedValue(19);
    analyzeImportJob.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });

    const result = await processNextImport();

    expect(analyzeBatchWithPool).toHaveBeenCalledTimes(1);
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("blocks the 21st AI call and leaves the item untouched for the next day", async () => {
    pendingAnalysisWith(50_000);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    // Nothing written: the row is still PENDING_ANALYSIS, first in line tomorrow.
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: false, item: null, dailyLimitReached: true });
  });

  it("stops when every provider is out of capacity", async () => {
    pendingAnalysisWith(50_000);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(anyProviderAvailable).toHaveBeenCalled();
    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    expect(result.dailyLimitReached).toBe(true);
  });

  it("low-follower accounts consume no slot: they are still skipped at the limit", async () => {
    pendingAnalysisWith(1_200);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: expect.stringContaining("1,200") },
    });
    // Processed normally — the allowance was never consulted for this item.
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("does not start a new Apify parse once the allowance is spent", async () => {
    findFirst.mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
    exhaustAllProviders();

    const result = await processNextImport();

    expect(parseInstagramProfile).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.dailyLimitReached).toBe(true);
  });
});

/**
 * Every project is briefly unwell (503/504/429) but still has allowance left.
 * Unlike a spent day, this clears on its own, so the caller is told WHEN.
 */
function coolDownAllProviders(primaryUntil: Date, fallbackUntil: Date) {
  anyProviderAvailable.mockResolvedValue({
    available: false,
    usage: [
      { id: "primary", projectId: "proj-a", used: 3, limit: 20, cooldownUntil: primaryUntil, available: false },
      { id: "fallback", projectId: "proj-b", used: 1, limit: 20, cooldownUntil: fallbackUntil, available: false },
    ],
  });
}

describe("temporary provider cooldown (503/504) pauses instead of stopping", () => {
  const soon = new Date("2026-09-23T10:10:00.000Z");
  const later = new Date("2026-09-23T10:18:00.000Z");

  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports when to retry rather than ending the day", async () => {
    pendingAnalysisWith(50_000);
    coolDownAllProviders(soon, later);

    const result = await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    // Untouched, exactly as at the daily limit — but the caller may come back.
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: false, item: null, retryAfter: soon.toISOString() });
    // The run must NOT be told to give up for the day.
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("waits only for the project that recovers first", async () => {
    pendingAnalysisWith(50_000);
    coolDownAllProviders(later, soon);

    const result = await processNextImport();

    expect(result.retryAfter).toBe(soon.toISOString());
  });

  it("ignores the cooldown of a project whose daily budget is already spent", async () => {
    pendingAnalysisWith(50_000);
    anyProviderAvailable.mockResolvedValue({
      available: false,
      usage: [
        // Spent AND cooling down: waiting for it buys nothing — it is done for today.
        { id: "primary", projectId: "proj-a", used: 20, limit: 20, cooldownUntil: soon, available: false },
        { id: "fallback", projectId: "proj-b", used: 2, limit: 20, cooldownUntil: later, available: false },
      ],
    });

    const result = await processNextImport();

    expect(result.retryAfter).toBe(later.toISOString());
  });

  it("still stops for the day when the allowance is genuinely spent", async () => {
    pendingAnalysisWith(50_000);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(result.dailyLimitReached).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  it("pauses the parse stage too, so no Apify credit is spent while waiting", async () => {
    findFirst.mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
    coolDownAllProviders(soon, later);

    const result = await processNextImport();

    expect(parseInstagramProfile).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.retryAfter).toBe(soon.toISOString());
    expect(result.dailyLimitReached).toBeUndefined();
  });
});

describe("retryQueueItem", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-queues a PARSE_FAILED item to PENDING_PARSE", async () => {
    findUnique.mockResolvedValue({ id: "r1", status: "PARSE_FAILED" });
    await retryQueueItem("r1");
    expect(update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "PENDING_PARSE", error: null },
    });
  });

  it("re-queues an ANALYSIS_FAILED item to PENDING_ANALYSIS (re-analyze only)", async () => {
    findUnique.mockResolvedValue({ id: "r2", status: "ANALYSIS_FAILED" });
    await retryQueueItem("r2");
    expect(update).toHaveBeenCalledWith({
      where: { id: "r2" },
      data: { status: "PENDING_ANALYSIS", error: null },
    });
  });

  it("refuses to retry a SKIPPED_LOW_FOLLOWERS item — the skip is terminal", async () => {
    findUnique.mockResolvedValue({ id: "r4", status: "SKIPPED_LOW_FOLLOWERS" });
    await expect(retryQueueItem("r4")).rejects.toThrow(/Cannot retry/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses to retry an item that is not in a failed state", async () => {
    findUnique.mockResolvedValue({ id: "r3", status: "READY_FOR_REVIEW" });
    await expect(retryQueueItem("r3")).rejects.toThrow(/Cannot retry/);
    expect(update).not.toHaveBeenCalled();
  });

  it("throws when the item is missing", async () => {
    findUnique.mockResolvedValue(null);
    await expect(retryQueueItem("nope")).rejects.toThrow(/not found/);
  });
});

describe("deleteQueueItem", () => {
  beforeEach(() => resetAll());

  it("deletes a single row by id (any status) and returns the count", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    const result = await deleteQueueItem("abc");
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "abc" } });
    expect(result).toEqual({ deleted: 1 });
  });

  it("is idempotent when the row is already gone", async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    expect(await deleteQueueItem("missing")).toEqual({ deleted: 0 });
  });
});

describe("clearQueue", () => {
  beforeEach(() => resetAll());

  it("clears success rows (READY_FOR_REVIEW + legacy COMPLETED) for COMPLETED scope", async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    const result = await clearQueue("COMPLETED");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { status: { in: ["READY_FOR_REVIEW", "COMPLETED"] } },
    });
    expect(result).toEqual({ deleted: 3 });
  });

  it("clears failed rows (PARSE_FAILED + ANALYSIS_FAILED + legacy FAILED) for FAILED scope", async () => {
    deleteMany.mockResolvedValue({ count: 2 });
    await clearQueue("FAILED");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { status: { in: ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"] } },
    });
  });

  it("never deletes SKIPPED_LOW_FOLLOWERS as part of Clear Failed", async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    await clearQueue("FAILED");
    const where = (deleteMany.mock.calls[0]?.[0] as { where: { status: { in: string[] } } }).where;
    expect(where.status.in).not.toContain("SKIPPED_LOW_FOLLOWERS");
  });

  it("clears every row for ALL (no status filter)", async () => {
    deleteMany.mockResolvedValue({ count: 9 });
    const result = await clearQueue("ALL");
    expect(deleteMany).toHaveBeenCalledWith({ where: {} });
    expect(result).toEqual({ deleted: 9 });
  });
});

/**
 * Re-importing a profile we already hold buys nothing and costs both Apify and
 * Gemini. The guard runs twice — once when URLs are pasted, once again right
 * before the scrape, because a boutique can appear in between.
 */
describe("duplicate protection", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** Queue a single PENDING_PARSE row for `url`. */
  function pendingParse(url: string) {
    findFirst.mockResolvedValue({ id: "p1", instagramUrl: url, importJobId: null });
    count.mockResolvedValue(0);
    update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "p1",
        instagramUrl: url,
        status: data.status,
        error: data.error ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  }

  it("marks an already-imported handle SKIPPED_DUPLICATE", async () => {
    pendingParse("https://instagram.com/qoima");
    boutiqueFindFirst.mockResolvedValue({ id: "b1" });

    const result = await processNextImport();

    expect(update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { status: "SKIPPED_DUPLICATE", error: "Skipped: @qoima is already imported." },
    });
    expect(result.item?.status).toBe("SKIPPED_DUPLICATE");
    // Not a failure: the run carries on to the next item.
    expect(result.processed).toBe(true);
  });

  it("spends NO Apify call on a duplicate", async () => {
    pendingParse("https://instagram.com/qoima");
    boutiqueFindFirst.mockResolvedValue({ id: "b1" });

    await processNextImport();

    expect(parseInstagramProfile).not.toHaveBeenCalled();
  });

  it("spends NO Gemini call on a duplicate", async () => {
    pendingParse("https://instagram.com/qoima");
    boutiqueFindFirst.mockResolvedValue({ id: "b1" });

    await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
  });

  it("never even marks it PARSING — the check runs before the scrape begins", async () => {
    pendingParse("https://instagram.com/qoima");
    boutiqueFindFirst.mockResolvedValue({ id: "b1" });

    await processNextImport();

    const statuses = update.mock.calls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses).not.toContain("PARSING");
  });

  it("parses normally when the handle is NOT already imported", async () => {
    pendingParse("https://instagram.com/newshop");
    boutiqueFindFirst.mockResolvedValue(null);
    parseInstagramProfile.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });

    await processNextImport();

    expect(parseInstagramProfile).toHaveBeenCalledWith({
      url: "https://instagram.com/newshop",
      userId: null,
    });
  });

  it("asks Postgres for a CASE-INSENSITIVE match, so @Qoima and @qoima are one shop", async () => {
    // The URL side is already lower-cased by parseInstagramHandle; the STORED
    // side is whatever Apify returned, so the insensitivity has to come from
    // the query or a shop saved as "Qoima" would be imported twice.
    pendingParse("https://instagram.com/Qoima");
    boutiqueFindFirst.mockResolvedValue({ id: "b1" });

    await processNextImport();

    expect(boutiqueFindFirst).toHaveBeenCalledWith({
      where: { instagramHandle: { equals: "qoima", mode: "insensitive" } },
      select: { id: true },
    });
  });

  it.each(["APPROVED", "REJECTED", "DRAFT", "NEEDS_REVIEW", "PUBLISHED"])(
    "treats an existing %s boutique as a duplicate",
    async (status) => {
      // Any status means a decision already exists for this profile.
      pendingParse("https://instagram.com/qoima");
      boutiqueFindFirst.mockResolvedValue({ id: `b-${status}` });

      const result = await processNextImport();

      expect(result.item?.status).toBe("SKIPPED_DUPLICATE");
      expect(parseInstagramProfile).not.toHaveBeenCalled();
    },
  );

  it("blocks a duplicate that appeared AFTER the URL was queued", async () => {
    // The add-time filter saw nothing; by the time the item is picked up the
    // boutique exists. Only this second check can stop the Apify call.
    pendingParse("https://instagram.com/qoima");
    boutiqueFindMany.mockResolvedValue([]); // add-time filter found nothing
    boutiqueFindFirst.mockResolvedValue({ id: "b1" }); // but now it exists

    const result = await processNextImport();

    expect(parseInstagramProfile).not.toHaveBeenCalled();
    expect(result.item?.status).toBe("SKIPPED_DUPLICATE");
  });
});

describe("addUrlsToQueue duplicate filter", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts added, invalid and already-imported separately", async () => {
    boutiqueFindMany.mockResolvedValue([{ instagramHandle: "qoima" }]);

    const result = await addUrlsToQueue(
      ["https://instagram.com/qoima", "https://instagram.com/newshop", "not-a-url"].join("\n"),
    );

    expect(result).toEqual({ added: 1, skipped: 1, duplicates: 1 });
  });

  it("queues ONLY the fresh URL", async () => {
    boutiqueFindMany.mockResolvedValue([{ instagramHandle: "qoima" }]);

    await addUrlsToQueue(["https://instagram.com/qoima", "https://instagram.com/newshop"].join("\n"));

    expect(queueCreateMany).toHaveBeenCalledWith({
      data: [{ instagramUrl: "https://instagram.com/newshop" }],
    });
  });

  it("matches regardless of case — stored @Qoima blocks pasted @QOIMA", async () => {
    boutiqueFindMany.mockResolvedValue([{ instagramHandle: "Qoima" }]);

    const result = await addUrlsToQueue("https://instagram.com/QOIMA");

    expect(result.duplicates).toBe(1);
    expect(queueCreateMany).not.toHaveBeenCalled();
  });

  it("asks for every handle case-insensitively", async () => {
    boutiqueFindMany.mockResolvedValue([]);

    await addUrlsToQueue("https://instagram.com/Qoima");

    expect(boutiqueFindMany).toHaveBeenCalledWith({
      where: { OR: [{ instagramHandle: { equals: "qoima", mode: "insensitive" } }] },
      select: { instagramHandle: true },
    });
  });

  it("does not query at all when nothing valid was pasted", async () => {
    const result = await addUrlsToQueue("not-a-url\nalso-not-a-url");

    expect(result).toEqual({ added: 0, skipped: 2, duplicates: 0 });
    expect(boutiqueFindMany).not.toHaveBeenCalled();
    expect(queueCreateMany).not.toHaveBeenCalled();
  });
});

/**
 * The reason batching exists: a provider's daily allowance is spent per
 * REQUEST, so three shops answered together must cost one request, not three.
 */
describe("batch analysis", () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      instagramUrl: `https://instagram.com/s${i}`,
      importJobId: `job-${i}`,
    }));

  it("sends THREE shops in ONE model request", async () => {
    pendingAnalysis(rows(3));

    await processNextImport();

    expect(analyzeBatchWithPool).toHaveBeenCalledTimes(1);
    const [items] = analyzeBatchWithPool.mock.calls[0] as [{ handle: string }[]];
    expect(items.map((i) => i.handle)).toEqual(["h-job-0", "h-job-1", "h-job-2"]);
  });

  it("settles every shop in the batch, not just the first", async () => {
    pendingAnalysis(rows(3));
    update.mockImplementation(({ where, data }: { where: { id: string }; data: { status: string } }) =>
      Promise.resolve({
        id: where.id,
        instagramUrl: "u",
        status: data.status,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const result = await processNextImport();

    expect(applyAnalysisResult).toHaveBeenCalledTimes(3);
    expect(result.items).toHaveLength(3);
    expect(result.items!.every((i) => i.status === "READY_FOR_REVIEW")).toBe(true);
  });

  it("a shop the model declines does NOT spoil the others", async () => {
    pendingAnalysis(rows(3));
    analyzeBatchWithPool.mockImplementation((items: { handle: string }[]) =>
      Promise.resolve({
        batch: {
          results: new Map(items.slice(0, 2).map((i) => [i.handle, aiResult()])),
          skipped: [{ handle: items[2]!.handle, reason: "no clothing signal" }],
        },
        providerId: "primary",
        providerName: "gemini",
      }),
    );

    await processNextImport();

    // Two analyzed, one carries the model's reason and is NOT analyzed.
    expect(applyAnalysisResult).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: "q2" },
      data: { status: "ANALYSIS_FAILED", error: "Skipped by AI: no clothing signal" },
    });
  });

  it("a failed batch marks every shop retryable and analyzes none", async () => {
    pendingAnalysis(rows(3));
    analyzeBatchWithPool.mockRejectedValue(new Error("Gemini 503"));

    await processNextImport();

    expect(applyAnalysisResult).not.toHaveBeenCalled();
    for (const id of ["q0", "q1", "q2"]) {
      expect(update).toHaveBeenCalledWith({
        where: { id },
        data: { status: "ANALYSIS_FAILED", error: "Gemini 503" },
      });
    }
  });

  it("keeps a repeated handle out of the same batch — the reply must stay unambiguous", async () => {
    pendingAnalysis(rows(2));
    prepareAnalysisJob.mockImplementation((jobId: string) =>
      Promise.resolve({
        jobId,
        handle: "same", // both rows resolve to one handle
        rawProfile: {},
        prepared: { keyword: [], enrichment: {}, request: {} },
      }),
    );

    await processNextImport();

    const [items] = analyzeBatchWithPool.mock.calls[0] as [{ handle: string }[]];
    expect(items).toHaveLength(1);
  });

  it("low-follower shops are settled without entering the batch at all", async () => {
    pendingAnalysis(rows(2));
    jobFindUnique.mockResolvedValue({ rawProfile: { followersCount: 100 } });

    await processNextImport();

    expect(analyzeBatchWithPool).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q0" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: expect.stringContaining("100") },
    });
  });
});
