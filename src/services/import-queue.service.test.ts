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

const { parseInstagramProfile, analyzeImportJob } = vi.hoisted(() => ({
  parseInstagramProfile: vi.fn(),
  analyzeImportJob: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importQueue: { findFirst, findUnique, findMany, update, updateMany, deleteMany, count },
  },
}));

vi.mock("@/services/import.service", () => ({ parseInstagramProfile, analyzeImportJob }));

import {
  clearQueue,
  deleteQueueItem,
  processNextImport,
  requeueStaleJobs,
  retryQueueItem,
} from "./import-queue.service";

function resetAll() {
  for (const fn of [findFirst, findUnique, findMany, update, updateMany, deleteMany, count]) {
    fn.mockReset();
  }
  parseInstagramProfile.mockReset();
  analyzeImportJob.mockReset();
  // Default: no stale jobs, nothing to promote, queue drained.
  findMany.mockResolvedValue([]);
  updateMany.mockResolvedValue({ count: 0 });
  findFirst.mockResolvedValue(null);
  count.mockResolvedValue(0);
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

  it("clears every row for ALL (no status filter)", async () => {
    deleteMany.mockResolvedValue({ count: 9 });
    const result = await clearQueue("ALL");
    expect(deleteMany).toHaveBeenCalledWith({ where: {} });
    expect(result).toEqual({ deleted: 9 });
  });
});
