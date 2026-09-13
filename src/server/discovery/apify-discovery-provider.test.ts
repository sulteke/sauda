import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApifyDiscoveryProvider } from "./apify-discovery-provider";
import type { DiscoverOptions } from "./discovery-provider";

/** A hashtag post as the Apify actor returns it (owner fields only). */
function post(ownerUsername: string, ownerFullName: string | null = null) {
  return { ownerUsername, ownerFullName };
}

/** Wraps an array payload in a minimal OK fetch Response. */
function okResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

/** isKnownHandles backed by a fixed set (case-insensitive), like the real DB check. */
function knownHandles(...handles: string[]): DiscoverOptions["isKnownHandles"] {
  const set = new Set(handles.map((h) => h.toLowerCase()));
  return async (batch: string[]) =>
    new Set(batch.filter((h) => set.has(h.toLowerCase())).map((h) => h.toLowerCase()));
}

describe("ApifyDiscoveryProvider — hashtag pagination", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalLimit = process.env.APIFY_DISCOVERY_RESULTS_LIMIT;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.APIFY_DISCOVERY_RESULTS_LIMIT; // isolate from the host .env
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalLimit === undefined) delete process.env.APIFY_DISCOVERY_RESULTS_LIMIT;
    else process.env.APIFY_DISCOVERY_RESULTS_LIMIT = originalLimit;
  });

  function provider() {
    return new ApifyDiscoveryProvider({ token: "t", baseUrl: "https://apify.test" });
  }

  /** Parses the single structured `discovery.pagination` metric from the logs. */
  function paginationMetric(): Record<string, unknown> {
    const line = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes('"discovery.pagination"'));
    if (!line) throw new Error("discovery.pagination metric was not logged");
    return JSON.parse(line) as Record<string, unknown>;
  }

  it("walks pages and stops exactly at 10 NEW accounts (the worked example)", async () => {
    // Page 1: 10 already-known owners → 0 new. Pages 2–4 add 2, 5, 3 new = 10.
    const page1 = Array.from({ length: 10 }, (_, i) => post(`known${i}`));
    const page2 = [
      ...Array.from({ length: 8 }, (_, i) => post(`known_b${i}`)),
      post("new01"),
      post("new02"),
    ];
    const page3 = [
      ...Array.from({ length: 5 }, (_, i) => post(`known_c${i}`)),
      post("new03"),
      post("new04"),
      post("new05"),
      post("new06"),
      post("new07"),
    ];
    const page4 = [
      ...Array.from({ length: 7 }, (_, i) => post(`known_d${i}`)),
      post("new08"),
      post("new09"),
      post("new10"),
    ];
    // A 5th page exists but must never be consumed once the target is hit.
    const page5 = Array.from({ length: 10 }, (_, i) => post(`extra${i}`));
    const posts = [...page1, ...page2, ...page3, ...page4, ...page5];
    fetchMock.mockResolvedValue(okResponse(posts));

    const known = [
      ...page1.map((p) => p.ownerUsername),
      ...page2.slice(0, 8).map((p) => p.ownerUsername),
      ...page3.slice(0, 5).map((p) => p.ownerUsername),
      ...page4.slice(0, 7).map((p) => p.ownerUsername),
    ];

    const result = await provider().discover(
      { type: "HASHTAG", value: "almatyshop" },
      { isKnownHandles: knownHandles(...known), targetNewCount: 10, pageSize: 10 },
    );

    expect(result).toHaveLength(10);
    expect(result.map((a) => a.handle)).toEqual([
      "new01", "new02", "new03", "new04", "new05",
      "new06", "new07", "new08", "new09", "new10",
    ]);
    // Single Apify run — pages are slices of the one dataset.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.map((a) => a.instagramUrl)).toContain("https://www.instagram.com/new01/");
    // The 5th page's accounts were never collected (stopped at the target).
    expect(result.map((a) => a.handle)).not.toContain("extra0");

    // Structured metric: stopped because the target was reached on page 4.
    expect(paginationMetric()).toMatchObject({
      message: "discovery.pagination",
      hashtag: "almatyshop",
      resultsLimit: 300,
      pagesChecked: 4,
      accountsSeen: 40,
      existingAccounts: 30,
      newAccounts: 10,
      returnedAccounts: 10,
      stoppedReason: "target_reached",
    });
  });

  it("does NOT stop when a page yields zero new accounts", async () => {
    // First 10 all known, then 1 new — must reach the new one on page 2.
    const posts = [
      ...Array.from({ length: 10 }, (_, i) => post(`seen${i}`)),
      post("fresh"),
    ];
    fetchMock.mockResolvedValue(okResponse(posts));

    const result = await provider().discover(
      { type: "HASHTAG", value: "almatyshop" },
      {
        isKnownHandles: knownHandles(...Array.from({ length: 10 }, (_, i) => `seen${i}`)),
        targetNewCount: 10,
        pageSize: 10,
      },
    );

    expect(result.map((a) => a.handle)).toEqual(["fresh"]);
  });

  it("stops when results are exhausted before reaching the target", async () => {
    fetchMock.mockResolvedValue(okResponse([post("a"), post("b"), post("a")])); // 'a' duplicated

    const result = await provider().discover(
      { type: "HASHTAG", value: "rarehashtag" },
      { isKnownHandles: knownHandles(), targetNewCount: 10, pageSize: 10 },
    );

    // Deduped to 2 unique accounts; no more pages, so we return what we have.
    expect(result.map((a) => a.handle)).toEqual(["a", "b"]);

    expect(paginationMetric()).toMatchObject({
      hashtag: "rarehashtag",
      pagesChecked: 1,
      accountsSeen: 2,
      existingAccounts: 0,
      newAccounts: 2,
      returnedAccounts: 2,
      stoppedReason: "dataset_exhausted",
    });
  });

  it("defaults the fetch cap to 300, and honors APIFY_DISCOVERY_RESULTS_LIMIT", async () => {
    fetchMock.mockResolvedValue(okResponse([]));

    // Default (env unset in beforeEach).
    await provider().discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles(), targetNewCount: 10, pageSize: 10 },
    );
    let body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.resultsLimit).toBe(300);

    // Env override is read at construction time.
    process.env.APIFY_DISCOVERY_RESULTS_LIMIT = "42";
    await new ApifyDiscoveryProvider({ token: "t", baseUrl: "https://apify.test" }).discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles(), targetNewCount: 10, pageSize: 10 },
    );
    body = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body);
    expect(body.resultsLimit).toBe(42);
  });

  it("sends the hashtag (incl. Cyrillic) to the actor and lowercases owner handles", async () => {
    fetchMock.mockResolvedValue(okResponse([post("Almaty_Boutique", "Almaty Boutique")]));

    const result = await provider().discover(
      { type: "HASHTAG", value: "алматыодежда" },
      { isKnownHandles: knownHandles(), targetNewCount: 10, pageSize: 10 },
    );

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.hashtags).toEqual(["алматыодежда"]);
    expect(body.resultsType).toBe("posts");
    expect(result[0]?.handle).toBe("almaty_boutique");
  });
});
