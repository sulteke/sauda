import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, updateMany, deleteMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { importQueue: { findMany, updateMany, deleteMany } },
}));

import { clearQueue, deleteQueueItem, requeueStaleJobs } from "./import-queue.service";

describe("requeueStaleJobs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findMany.mockReset();
    updateMany.mockReset();
    deleteMany.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("does nothing (and never writes) when no PROCESSING job is stale", async () => {
    findMany.mockResolvedValue([]);

    const count = await requeueStaleJobs();

    expect(count).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
      "queue.stale_job_detected",
    );
  });

  it("requeues PROCESSING jobs older than 10 minutes back to PENDING and logs", async () => {
    const stuckAt = new Date(Date.now() - 11 * 60 * 1000);
    findMany.mockResolvedValue([
      { id: "a", instagramUrl: "https://instagram.com/a", updatedAt: stuckAt },
      { id: "b", instagramUrl: "https://instagram.com/b", updatedAt: stuckAt },
    ]);
    updateMany.mockResolvedValue({ count: 2 });

    const count = await requeueStaleJobs();
    expect(count).toBe(2);

    // Queries PROCESSING jobs whose last update is older than the 10-min threshold.
    const where = (findMany.mock.calls[0]?.[0] as { where: { status: string; updatedAt: { lt: Date } } })
      .where;
    expect(where.status).toBe("PROCESSING");
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(10 * 60 * 1000 - 2000);

    // Flips exactly those to PENDING.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PROCESSING" }),
        data: { status: "PENDING" },
      }),
    );

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("queue.stale_job_detected");
    expect(logged).toContain("queue.job_requeued");
  });
});

describe("deleteQueueItem", () => {
  beforeEach(() => deleteMany.mockReset());

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
  beforeEach(() => deleteMany.mockReset());

  it("clears only COMPLETED rows", async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    const result = await clearQueue("COMPLETED");
    expect(deleteMany).toHaveBeenCalledWith({ where: { status: "COMPLETED" } });
    expect(result).toEqual({ deleted: 3 });
  });

  it("clears only FAILED rows", async () => {
    deleteMany.mockResolvedValue({ count: 2 });
    await clearQueue("FAILED");
    expect(deleteMany).toHaveBeenCalledWith({ where: { status: "FAILED" } });
  });

  it("clears every row for ALL (no status filter)", async () => {
    deleteMany.mockResolvedValue({ count: 9 });
    const result = await clearQueue("ALL");
    expect(deleteMany).toHaveBeenCalledWith({ where: {} });
    expect(result).toEqual({ deleted: 9 });
  });
});
