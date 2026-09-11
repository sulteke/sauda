import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, updateMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { importQueue: { findMany, updateMany } },
}));

import { requeueStaleJobs } from "./import-queue.service";

describe("requeueStaleJobs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findMany.mockReset();
    updateMany.mockReset();
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
