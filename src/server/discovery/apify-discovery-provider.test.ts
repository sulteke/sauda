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

/** Reads the request body of the Nth fetch call. */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[call]?.[1] as { body: string }).body);
}

describe("ApifyDiscoveryProvider — hashtag discovery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalLimit = process.env.APIFY_DISCOVERY_RESULTS_LIMIT;
  const originalActor = process.env.APIFY_DISCOVERY_HASHTAG_ACTOR;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.APIFY_DISCOVERY_RESULTS_LIMIT; // isolate from the host .env
    delete process.env.APIFY_DISCOVERY_HASHTAG_ACTOR;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalLimit === undefined) delete process.env.APIFY_DISCOVERY_RESULTS_LIMIT;
    else process.env.APIFY_DISCOVERY_RESULTS_LIMIT = originalLimit;
    if (originalActor === undefined) delete process.env.APIFY_DISCOVERY_HASHTAG_ACTOR;
    else process.env.APIFY_DISCOVERY_HASHTAG_ACTOR = originalActor;
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

  it("sends a directUrls explore/tags URL (not hashtags) and URL-encodes Cyrillic tags", async () => {
    fetchMock.mockResolvedValue(okResponse([post("Almaty_Boutique", "Almaty Boutique")]));

    const result = await provider().discover(
      { type: "HASHTAG", value: "алматыодежда" },
      { isKnownHandles: knownHandles() },
    );

    const body = requestBody(fetchMock);
    expect(body.directUrls).toEqual([
      `https://www.instagram.com/explore/tags/${encodeURIComponent("алматыодежда")}/`,
    ]);
    // The encoded URL is valid ASCII (percent-encoded), never raw Cyrillic bytes.
    expect(String((body.directUrls as string[])[0])).toMatch(/%[0-9A-F]{2}/);
    expect(body.resultsType).toBe("posts");
    expect(body).not.toHaveProperty("hashtags");
    // owner handle is normalized to lowercase.
    expect(result[0]?.handle).toBe("almaty_boutique");
  });

  it("targets the general instagram-scraper actor by default, configurable via env", async () => {
    fetchMock.mockResolvedValue(okResponse([]));

    // Default actor.
    await provider().discover({ type: "HASHTAG", value: "t" }, { isKnownHandles: knownHandles() });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items",
    );

    // Env override (read at construction time).
    process.env.APIFY_DISCOVERY_HASHTAG_ACTOR = "someuser~custom-actor";
    await new ApifyDiscoveryProvider({ token: "t", baseUrl: "https://apify.test" }).discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles() },
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v2/acts/someuser~custom-actor/");
  });

  it("collects NEW accounts across pages and continues past zero-new pages", async () => {
    // Page 1: 10 already-known owners → 0 new. Pages 2–4 add 2, 5, 3 new = 10.
    const page1 = Array.from({ length: 10 }, (_, i) => post(`known${i}`));
    const page2 = [...Array.from({ length: 8 }, (_, i) => post(`known_b${i}`)), post("new01"), post("new02")];
    const page3 = [
      ...Array.from({ length: 5 }, (_, i) => post(`known_c${i}`)),
      post("new03"), post("new04"), post("new05"), post("new06"), post("new07"),
    ];
    const page4 = [...Array.from({ length: 7 }, (_, i) => post(`known_d${i}`)), post("new08"), post("new09"), post("new10")];
    const page5 = Array.from({ length: 10 }, (_, i) => post(`extra${i}`)); // never consumed
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

    expect(result.map((a) => a.handle)).toEqual([
      "new01", "new02", "new03", "new04", "new05", "new06", "new07", "new08", "new09", "new10",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one dataset, walked in-memory
    expect(result.map((a) => a.handle)).not.toContain("extra0"); // stopped at the target
    expect(paginationMetric()).toMatchObject({
      pagesChecked: 4,
      existingAccounts: 30,
      newAccounts: 10,
      stoppedReason: "target_reached",
    });
  });

  it("does NOT stop when a page yields zero new accounts", async () => {
    const posts = [...Array.from({ length: 10 }, (_, i) => post(`seen${i}`)), post("fresh")];
    fetchMock.mockResolvedValue(okResponse(posts));

    const result = await provider().discover(
      { type: "HASHTAG", value: "almatyshop" },
      { isKnownHandles: knownHandles(...Array.from({ length: 10 }, (_, i) => `seen${i}`)), targetNewCount: 10, pageSize: 10 },
    );

    expect(result.map((a) => a.handle)).toEqual(["fresh"]);
  });

  it("skips duplicate owners within the same dataset", async () => {
    // 'shop_a' posts 3 times, 'shop_b' once → 2 unique accounts.
    fetchMock.mockResolvedValue(
      okResponse([post("shop_a"), post("shop_a"), post("shop_b"), post("shop_a")]),
    );

    const result = await provider().discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles(), targetNewCount: 50, pageSize: 10 },
    );

    expect(result.map((a) => a.handle)).toEqual(["shop_a", "shop_b"]);
  });

  it("defaults the target to 50 NEW accounts and stops there", async () => {
    // 60 unique NEW owners; with no targetNewCount option the default (50) applies.
    fetchMock.mockResolvedValue(okResponse(Array.from({ length: 60 }, (_, i) => post(`new${i}`))));

    const result = await provider().discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles() }, // no targetNewCount → default 50
    );

    expect(result).toHaveLength(50);
    expect(result.map((a) => a.handle)).not.toContain("new50");
    expect(paginationMetric()).toMatchObject({ newAccounts: 50, stoppedReason: "target_reached" });
  });

  it("stops when the dataset is exhausted before reaching the target", async () => {
    fetchMock.mockResolvedValue(okResponse([post("a"), post("b")]));

    const result = await provider().discover(
      { type: "HASHTAG", value: "rarehashtag" },
      { isKnownHandles: knownHandles(), targetNewCount: 50, pageSize: 10 },
    );

    expect(result.map((a) => a.handle)).toEqual(["a", "b"]);
    expect(paginationMetric()).toMatchObject({ newAccounts: 2, stoppedReason: "dataset_exhausted" });
  });

  it("defaults the fetch cap to 200 and honors APIFY_DISCOVERY_RESULTS_LIMIT", async () => {
    fetchMock.mockResolvedValue(okResponse([]));

    await provider().discover({ type: "HASHTAG", value: "t" }, { isKnownHandles: knownHandles() });
    expect(requestBody(fetchMock, 0).resultsLimit).toBe(200);

    process.env.APIFY_DISCOVERY_RESULTS_LIMIT = "42";
    await new ApifyDiscoveryProvider({ token: "t", baseUrl: "https://apify.test" }).discover(
      { type: "HASHTAG", value: "t" },
      { isKnownHandles: knownHandles() },
    );
    expect(requestBody(fetchMock, 1).resultsLimit).toBe(42);
  });
});

describe("ApifyDiscoveryProvider — profile discovery (unchanged)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses `usernames` input (not directUrls) and returns related accounts UNFILTERED", async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        {
          username: "seedshop",
          relatedProfiles: [{ username: "rel_new" }, { username: "rel_known" }],
        },
      ]),
    );

    const result = await new ApifyDiscoveryProvider({
      token: "t",
      baseUrl: "https://apify.test",
    }).discover(
      { type: "PROFILE", value: "seedshop" },
      // 'rel_known' is already in the DB — profile discovery must NOT filter it out.
      { isKnownHandles: knownHandles("rel_known"), targetNewCount: 50 },
    );

    const body = requestBody(fetchMock);
    expect(body.usernames).toEqual(["seedshop"]);
    expect(body).not.toHaveProperty("directUrls");
    // Both related accounts returned — the DB filter is intentionally not applied here.
    expect(result.map((a) => a.handle).sort()).toEqual(["rel_known", "rel_new"]);
  });
});
