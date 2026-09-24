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

// The pool's own failover rules live in ai-provider-pool.test.ts. Here it is a
// seam, so the PIPELINE's contract can be checked: refuse before scraping, and
// record a slot only after a success.
const { assertProviderAvailable } = vi.hoisted(() => ({ assertProviderAvailable: vi.fn() }));
const poolHandle = { name: "gemini", lastProviderId: null as string | null, analyze };
vi.mock("@/server/ai/ai-provider-pool", () => ({
  assertProviderAvailable,
  resolvePooledProvider: () => poolHandle,
}));

import { AiCategoryProviderError } from "@/lib/ai-category-provider";
import { DailyAnalysisLimitError } from "@/server/ai/analysis-budget";

import { runAnalyze, runDiscovery } from "./import-pipeline";

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
  for (const fn of [jobCount, jobUpdate, jobFindUniqueOrThrow, fetchProfile, analyze, assertProviderAvailable])
    fn.mockReset();
  assertProviderAvailable.mockResolvedValue(undefined);
  poolHandle.lastProviderId = "primary";
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
  it("runs normally while capacity is free, and records the slot against its provider", async () => {
    poolHandle.lastProviderId = "fallback";

    await runDiscovery("job-1");

    expect(analyze).toHaveBeenCalledTimes(1);
    const stamped = jobUpdate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.analyzedAt !== undefined);
    expect(stamped).toBeDefined();
    // Attribution travels with the stamp — the two are always written together.
    expect(stamped?.analyzedBy).toBe("fallback");
  });

  it("blocks the 21st invocation of the day", async () => {
    assertProviderAvailable.mockRejectedValue(new DailyAnalysisLimitError(20, 20));

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("refuses BEFORE scraping, so a blocked import costs no Apify credit", async () => {
    assertProviderAvailable.mockRejectedValue(new DailyAnalysisLimitError(20, 20));

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("refuses before touching the job, leaving no half-finished row", async () => {
    assertProviderAvailable.mockRejectedValue(new DailyAnalysisLimitError(20, 20));

    await expect(runDiscovery("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    // No PROCESSING transition, no attempts increment, no analyzedAt stamp.
    expect(jobUpdate).not.toHaveBeenCalled();
  });

  it("reports the real counts so the UI can explain the refusal", async () => {
    assertProviderAvailable.mockRejectedValue(new DailyAnalysisLimitError(20, 20));

    await expect(runDiscovery("job-1")).rejects.toMatchObject({ used: 20, limit: 20 });
    await expect(runDiscovery("job-1")).rejects.toThrow(/Daily AI limit reached \(20\/20/);
  });
});

describe("queue /analyze path (runAnalyze) records a slot ONLY on success", () => {
  // rawProfile present, so runAnalyze proceeds to the AI call.
  beforeEach(() => {
    jobFindUniqueOrThrow.mockResolvedValue({ id: "job-1", handle: "qoima", rawProfile: profile });
  });

  it("a Gemini failure (strict throw) marks FAILED and stamps NO analyzedAt", async () => {
    jobCount.mockResolvedValue(5); // budget free
    analyze.mockRejectedValue(
      new AiCategoryProviderError("Gemini request failed (503 Service Unavailable)", {
        provider: "gemini",
        status: 503,
      }),
    );

    await expect(runAnalyze("job-1")).rejects.toBeInstanceOf(AiCategoryProviderError);

    // The job is marked FAILED, but no write ever set analyzedAt — the slot is
    // preserved, which is the entire purpose of this change.
    const marked = jobUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(marked.some((d) => d.status === "FAILED")).toBe(true);
    expect(marked.some((d) => d.analyzedAt !== undefined)).toBe(false);
  });

  it("an AI retry never re-scrapes — Apify is untouched once rawProfile exists", async () => {
    jobCount.mockResolvedValue(5); // budget free
    analyze.mockRejectedValue(
      new AiCategoryProviderError("Gemini request failed (503 Service Unavailable)", {
        provider: "gemini",
        status: 503,
      }),
    );

    await expect(runAnalyze("job-1")).rejects.toBeInstanceOf(AiCategoryProviderError);

    // Retries live inside the AI provider, well past the scrape — so however
    // many attempts a 503 costs, none of them spends Apify credit.
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("AUDIT [8][9]: a failure writes NEITHER analyzedAt NOR analyzedBy", async () => {
    jobCount.mockResolvedValue(5);
    analyze.mockRejectedValue(
      new AiCategoryProviderError("Gemini request failed (503 Service Unavailable)", {
        provider: "gemini",
        status: 503,
      }),
    );

    await expect(runAnalyze("job-1")).rejects.toBeInstanceOf(AiCategoryProviderError);

    // The two are written together or not at all — an attribution without a
    // result would claim a project produced something it never did.
    const written = jobUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(written.some((d) => d.analyzedAt !== undefined)).toBe(false);
    expect(written.some((d) => d.analyzedBy !== undefined)).toBe(false);
  });

  it("fails without recording when every provider is out of capacity", async () => {
    // The pool refuses inside analyze() once no project can run.
    analyze.mockRejectedValue(new DailyAnalysisLimitError(40, 40));

    await expect(runAnalyze("job-1")).rejects.toBeInstanceOf(DailyAnalysisLimitError);
    expect(jobUpdate.mock.calls.some((c) => (c[0] as { data: Record<string, unknown> }).data.analyzedAt)).toBe(false);
  });
});
