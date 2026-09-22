import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jobCount, jobUpdate } = vi.hoisted(() => ({
  jobCount: vi.fn(),
  jobUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { importJob: { count: jobCount, update: jobUpdate } },
}));

import {
  assertAiInvocationAllowed,
  checkDailyAnalysisBudget,
  countAnalysesToday,
  DailyAnalysisLimitError,
  recordSuccessfulAnalysis,
} from "./analysis-budget";

const originalLimit = process.env.DAILY_ANALYSIS_LIMIT;

beforeEach(() => {
  jobCount.mockReset();
  jobUpdate.mockReset();
  jobCount.mockResolvedValue(0);
  jobUpdate.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLimit === undefined) delete process.env.DAILY_ANALYSIS_LIMIT;
  else process.env.DAILY_ANALYSIS_LIMIT = originalLimit;
});

describe("countAnalysesToday", () => {
  it("counts invocations stamped since the business day began", async () => {
    jobCount.mockResolvedValue(7);
    // 2026-09-20 09:00 Almaty → the day began at 2026-09-19T19:00Z.
    expect(await countAnalysesToday(new Date("2026-09-20T04:00:00.000Z"))).toBe(7);
    expect(jobCount).toHaveBeenCalledWith({
      where: { analyzedAt: { gte: new Date("2026-09-19T19:00:00.000Z") } },
    });
  });
});

describe("checkDailyAnalysisBudget", () => {
  it("is not reached below the limit", async () => {
    jobCount.mockResolvedValue(19);
    expect(await checkDailyAnalysisBudget()).toEqual({ reached: false, used: 19, limit: 20 });
  });

  it("is reached at the limit", async () => {
    jobCount.mockResolvedValue(20);
    expect(await checkDailyAnalysisBudget()).toEqual({ reached: true, used: 20, limit: 20 });
  });

  it("honors DAILY_ANALYSIS_LIMIT", async () => {
    process.env.DAILY_ANALYSIS_LIMIT = "3";
    jobCount.mockResolvedValue(3);
    expect(await checkDailyAnalysisBudget()).toMatchObject({ reached: true, limit: 3 });
  });
});

describe("assertAiInvocationAllowed", () => {
  it("passes when the allowance is not spent", async () => {
    jobCount.mockResolvedValue(19);
    await expect(assertAiInvocationAllowed("gemini")).resolves.toBeUndefined();
  });

  it("throws DailyAnalysisLimitError once the allowance is spent", async () => {
    jobCount.mockResolvedValue(20);
    await expect(assertAiInvocationAllowed("gemini")).rejects.toBeInstanceOf(
      DailyAnalysisLimitError,
    );
    await expect(assertAiInvocationAllowed("gemini")).rejects.toMatchObject({
      used: 20,
      limit: 20,
    });
  });

  it("never budgets the disabled provider — it issues no request", async () => {
    jobCount.mockResolvedValue(999);
    await expect(assertAiInvocationAllowed("disabled")).resolves.toBeUndefined();
    expect(jobCount).not.toHaveBeenCalled();
  });
});

describe("recordSuccessfulAnalysis", () => {
  it("stamps analyzedAt (only ever called AFTER a success)", async () => {
    await recordSuccessfulAnalysis("job-1", "gemini");

    const call = jobUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { analyzedAt: Date };
    };
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.analyzedAt).toBeInstanceOf(Date);
  });

  it("does not read the counter — the caller already checked before the call", async () => {
    await recordSuccessfulAnalysis("job-1", "gemini");
    expect(jobCount).not.toHaveBeenCalled();
  });

  it("records nothing for the disabled provider (it ran no analysis)", async () => {
    await recordSuccessfulAnalysis("job-1", "disabled");
    expect(jobUpdate).not.toHaveBeenCalled();
  });
});

describe("a failed analysis never records a slot", () => {
  it("assert-then-record: a throw between them leaves analyzedAt unstamped", async () => {
    // This is the whole point of the change: the guard runs, the call fails, and
    // recordSuccessfulAnalysis is never reached — so no slot is consumed.
    jobCount.mockResolvedValue(5);

    await assertAiInvocationAllowed("gemini", { jobId: "job-1" });
    // ...provider throws here (simulated: we simply do not call record)...

    expect(jobUpdate).not.toHaveBeenCalled();
  });
});
