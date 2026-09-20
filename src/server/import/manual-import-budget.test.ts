import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jobCount, jobUpdate, jobFindUniqueOrThrow } = vi.hoisted(() => ({
  jobCount: vi.fn(),
  jobUpdate: vi.fn(),
  jobFindUniqueOrThrow: vi.fn(),
}));

const { fetchProfile } = vi.hoisted(() => ({ fetchProfile: vi.fn() }));
const { analyze } = vi.hoisted(() => ({ analyze: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { count: jobCount, update: jobUpdate, findUniqueOrThrow: jobFindUniqueOrThrow },
  },
}));

vi.mock("./instagram-provider", () => ({
  getInstagramProvider: () => ({ name: "mock", fetchProfile }),
}));

vi.mock("@/server/ai/gemini-category-provider", () => ({
  resolveAiCategoryProvider: () => ({ name: "gemini", analyze }),
}));

import { DailyAnalysisLimitError } from "@/server/ai/analysis-budget";

import { runDiscovery } from "./import-pipeline";

/** A minimal profile the manual import can map into a preview. */
const profile = {
  handle: "qoima",
  fullName: "Qoima",
  biography: "Худи и джинсы, Алматы",
  profilePicUrl: null,
  externalUrl: null,
  followersCount: 9000,
  isVerified: false,
  recentPosts: [],
  postsCount: 3,
  followsCount: 1,
  isBusinessAccount: true,
  isPrivate: false,
  businessAddress: null,
  externalUrls: [],
  relatedProfiles: [],
  sourceUrl: "https://instagram.com/qoima",
  fetchedAt: new Date().toISOString(),
  raw: {},
};

beforeEach(() => {
  for (const fn of [jobCount, jobUpdate, jobFindUniqueOrThrow, fetchProfile, analyze]) fn.mockReset();
  jobUpdate.mockResolvedValue({ id: "job-1" });
  jobFindUniqueOrThrow.mockResolvedValue({
    id: "job-1",
    handle: "qoima",
    sourceUrl: "https://instagram.com/qoima",
  });
  fetchProfile.mockResolvedValue(profile);
  analyze.mockResolvedValue({
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("manual /import path (runDiscovery) shares the daily AI budget", () => {
  it("runs normally while the allowance is free, and stamps the invocation", async () => {
    jobCount.mockResolvedValue(19); // the 20th call of the day

    await runDiscovery("job-1");

    expect(analyze).toHaveBeenCalledTimes(1);
    const stamped = jobUpdate.mock.calls.find(
      (c) => (c[0] as { data: Record<string, unknown> }).data.analyzedAt !== undefined,
    );
    expect(stamped).toBeDefined();
  });

  it("blocks the 21st invocation of the day", async () => {
    jobCount.mockResolvedValue(20);

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("refuses BEFORE scraping, so a blocked import costs no Apify credit", async () => {
    jobCount.mockResolvedValue(20);

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("refuses before touching the job, leaving no half-finished row", async () => {
    jobCount.mockResolvedValue(20);

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    // No PROCESSING transition, no attempts increment, no analyzedAt stamp.
    expect(jobUpdate).not.toHaveBeenCalled();
  });

  it("reports the real counts so the UI can explain the refusal", async () => {
    jobCount.mockResolvedValue(20);

    await expect(runDiscovery("job-1")).rejects.toMatchObject({ used: 20, limit: 20 });
    await expect(runDiscovery("job-1")).rejects.toThrow(/Daily analysis limit reached \(20\/20/);
  });
});
