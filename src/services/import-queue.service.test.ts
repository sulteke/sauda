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

const { parseInstagramProfile, analyzeImportJob } = vi.hoisted(() => ({
  parseInstagramProfile: vi.fn(),
  analyzeImportJob: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importQueue: { findFirst, findUnique, findMany, update, updateMany, deleteMany, count },
    importJob: { findUnique: jobFindUnique, count: jobCount },
  },
}));

vi.mock("@/services/import.service", () => ({ parseInstagramProfile, analyzeImportJob }));

// Provider availability is the pool's job and is covered in its own test file;
// here it is a dial, so the queue's reaction to "no capacity" can be exercised.
const { anyProviderAvailable } = vi.hoisted(() => ({ anyProviderAvailable: vi.fn() }));
vi.mock("@/server/ai/ai-provider-pool", () => ({ anyProviderAvailable }));

import {
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
  ]) {
    fn.mockReset();
  }
  parseInstagramProfile.mockReset();
  analyzeImportJob.mockReset();
  // Default: no stale jobs, nothing to promote, queue drained.
  findMany.mockResolvedValue([]);
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
    expect(analyzeImportJob).not.toHaveBeenCalled();
  });

  it("parses the oldest PENDING_PARSE item (Apify only) and hands off to PENDING_ANALYSIS", async () => {
    // First findFirst (PENDING_ANALYSIS) → none; second (PENDING_PARSE) → a row.
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
    parseInstagramProfile.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });
    count.mockResolvedValue(0);

    const result = await processNextImport();

    expect(parseInstagramProfile).toHaveBeenCalledWith({
      url: "https://instagram.com/p1",
      userId: null,
    });
    expect(analyzeImportJob).not.toHaveBeenCalled(); // no Gemini in the parse stage
    // Marked PARSING then handed straight off to PENDING_ANALYSIS, linked to the ImportJob.
    expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { status: "PARSING" } });
    expect(update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { status: "PENDING_ANALYSIS", importJobId: "job-1", error: null },
    });
    expect(result.processed).toBe(true);
  });

  it("prioritises analysis: analyzes a PENDING_ANALYSIS item via its linked job (no Apify)", async () => {
    findFirst.mockResolvedValueOnce({
      id: "a1",
      instagramUrl: "https://instagram.com/a1",
      importJobId: "job-9",
    });
    analyzeImportJob.mockResolvedValue({ job: { id: "job-9" }, boutiqueId: "b9" });

    const result = await processNextImport();

    expect(analyzeImportJob).toHaveBeenCalledWith("job-9");
    expect(parseInstagramProfile).not.toHaveBeenCalled(); // never re-scrapes during analysis
    expect(update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { status: "ANALYZING" } });
    expect(update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "READY_FOR_REVIEW", error: null },
    });
    expect(result.processed).toBe(true);
  });

  it("marks PARSE_FAILED when Apify fails, without touching analysis", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p2", instagramUrl: "https://instagram.com/p2", importJobId: null });
    parseInstagramProfile.mockRejectedValue(new Error("Apify timed out"));

    await processNextImport();

    expect(update).toHaveBeenCalledWith({
      where: { id: "p2" },
      data: { status: "PARSE_FAILED", error: "Apify timed out" },
    });
    expect(analyzeImportJob).not.toHaveBeenCalled();
  });

  it("marks ANALYSIS_FAILED when Gemini fails, leaving the parsed data intact (no re-scrape)", async () => {
    findFirst.mockResolvedValueOnce({
      id: "a2",
      instagramUrl: "https://instagram.com/a2",
      importJobId: "job-7",
    });
    analyzeImportJob.mockRejectedValue(new Error("Gemini 503"));

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
  findFirst.mockResolvedValueOnce({
    id: "q1",
    instagramUrl: "https://instagram.com/q1",
    importJobId: "job-1",
  });
  jobFindUnique.mockResolvedValue({ rawProfile: { followersCount } });
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

    expect(analyzeImportJob).not.toHaveBeenCalled();
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

    expect(analyzeImportJob).toHaveBeenCalledWith("job-1");
  });

  it("10,000 followers qualifies: the AI IS called", async () => {
    pendingAnalysisWith(10_000);
    analyzeImportJob.mockResolvedValue({ job: { id: "job-1" }, boutiqueId: "b1" });

    await processNextImport();

    expect(analyzeImportJob).toHaveBeenCalledWith("job-1");
  });

  it("skips conservatively when the follower count is unavailable (null)", async () => {
    pendingAnalysisWith(null);

    await processNextImport();

    expect(analyzeImportJob).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: "Skipped: follower count unavailable." },
    });
  });

  it("keeps an unparsed job retryable (ANALYSIS_FAILED) instead of skipping it", async () => {
    findFirst.mockResolvedValueOnce({
      id: "q1",
      instagramUrl: "https://instagram.com/q1",
      importJobId: "job-1",
    });
    jobFindUnique.mockResolvedValue({ rawProfile: null });
    analyzeImportJob.mockRejectedValue(new Error("Import job has not been parsed yet"));

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

    expect(analyzeImportJob).toHaveBeenCalledWith("job-1");
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("blocks the 21st AI call and leaves the item untouched for the next day", async () => {
    pendingAnalysisWith(50_000);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(analyzeImportJob).not.toHaveBeenCalled();
    // Nothing written: the row is still PENDING_ANALYSIS, first in line tomorrow.
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: false, item: null, dailyLimitReached: true });
  });

  it("stops when every provider is out of capacity", async () => {
    pendingAnalysisWith(50_000);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(anyProviderAvailable).toHaveBeenCalled();
    expect(analyzeImportJob).not.toHaveBeenCalled();
    expect(result.dailyLimitReached).toBe(true);
  });

  it("low-follower accounts consume no slot: they are still skipped at the limit", async () => {
    pendingAnalysisWith(1_200);
    exhaustAllProviders();

    const result = await processNextImport();

    expect(analyzeImportJob).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "q1" },
      data: { status: "SKIPPED_LOW_FOLLOWERS", error: expect.stringContaining("1,200") },
    });
    // Processed normally — the allowance was never consulted for this item.
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("does not start a new Apify parse once the allowance is spent", async () => {
    findFirst
      .mockResolvedValueOnce(null) // no pending analysis
      .mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
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

    expect(analyzeImportJob).not.toHaveBeenCalled();
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
    findFirst
      .mockResolvedValueOnce(null) // no pending analysis
      .mockResolvedValueOnce({ id: "p1", instagramUrl: "https://instagram.com/p1", importJobId: null });
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
