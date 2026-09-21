import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { boutiqueFindMany, candFindMany, candUpsert, storeUpsert } = vi.hoisted(() => ({
  boutiqueFindMany: vi.fn(),
  candFindMany: vi.fn(),
  candUpsert: vi.fn(),
  storeUpsert: vi.fn(),
}));

const { fetchStores, fallbackFetchStores } = vi.hoisted(() => ({
  fetchStores: vi.fn(),
  fallbackFetchStores: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    boutique: { findMany: boutiqueFindMany },
    discoveryCandidate: { findMany: candFindMany, upsert: candUpsert },
    gisStore: { upsert: storeUpsert },
  },
}));

vi.mock("@/server/discovery/gis/resolve-gis-store-source", () => ({
  resolveGisStoreSources: () => ({
    primary: { name: "api", fetchStores },
    fallback: fallbackHolder.value,
  }),
}));

const fallbackHolder: { value: { name: string; fetchStores: typeof fetchStores } | null } = {
  value: null,
};

import { DEFAULT_DAILY_ANALYSIS_LIMIT, DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT, DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS } from "@/config/limits";

import { runGisDiscovery } from "./gis-discovery.service";

const APORT_WEST = "9430047375099302";

function store(over: Record<string, unknown> = {}) {
  return {
    gisId: "g1",
    name: "Zara",
    address: "Ташкентский тракт, 17к",
    rubric: "Магазин одежды",
    website: null,
    phone: null,
    instagramHandle: null,
    instagramUrl: null,
    latitude: null,
    longitude: null,
    locationId: APORT_WEST,
    locationName: "Aport Mall West",
    gisUrl: "https://2gis.kz/firm/g1",
    ...over,
  };
}

const withIg = (handle: string, over: Record<string, unknown> = {}) =>
  store({
    instagramHandle: handle,
    instagramUrl: `https://www.instagram.com/${handle}`,
    ...over,
  });

beforeEach(() => {
  for (const fn of [boutiqueFindMany, candFindMany, candUpsert, storeUpsert, fetchStores, fallbackFetchStores]) {
    fn.mockReset();
  }
  boutiqueFindMany.mockResolvedValue([]);
  candFindMany.mockResolvedValue([]);
  candUpsert.mockImplementation(() => Promise.resolve({ id: "cand-1" }));
  storeUpsert.mockResolvedValue({});
  fallbackHolder.value = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("2GIS discovery → existing pipeline", () => {
  it("creates a DiscoveryCandidate tagged as 2GIS for a store with Instagram", async () => {
    fetchStores.mockResolvedValue([withIg("zara_kz")]);

    const result = await runGisDiscovery(APORT_WEST, { locationName: "Aport Mall West" });

    const args = candUpsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      where: unknown;
    };
    expect(args.create).toMatchObject({
      handle: "zara_kz",
      instagramUrl: "https://www.instagram.com/zara_kz",
      seedType: "GIS_LOCATION",
      seedValue: APORT_WEST,
      source: "2gis",
    });
    // 2GIS provenance travels with the candidate.
    expect(args.create.sourceMeta).toMatchObject({
      locationId: APORT_WEST,
      locationName: "Aport Mall West",
      gisId: "g1",
    });
    expect(result.newCandidates).toBe(1);
  });

  it("records the store with the candidate it produced", async () => {
    fetchStores.mockResolvedValue([withIg("zara_kz")]);

    await runGisDiscovery(APORT_WEST);

    const args = storeUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(args.create).toMatchObject({
      gisId: "g1",
      status: "INSTAGRAM_FOUND",
      instagramHandle: "zara_kz",
      candidateId: "cand-1",
      source: "api",
    });
  });

  it("keeps a store with NO Instagram instead of discarding or guessing it", async () => {
    fetchStores.mockResolvedValue([store({ name: "Local Shop" })]);

    const result = await runGisDiscovery(APORT_WEST);

    expect(candUpsert).not.toHaveBeenCalled();
    const args = storeUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(args.create).toMatchObject({ status: "NO_INSTAGRAM", instagramHandle: null });
    expect(result).toMatchObject({ noInstagram: 1, newCandidates: 0 });
  });
});

describe("deduplication", () => {
  it("does not re-create a candidate for an Instagram already a boutique", async () => {
    fetchStores.mockResolvedValue([withIg("zara_kz")]);
    boutiqueFindMany.mockResolvedValue([{ instagramHandle: "Zara_KZ" }]); // case differs

    const result = await runGisDiscovery(APORT_WEST);

    expect(candUpsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyKnown: 1, newCandidates: 0, instagramFound: 1 });
    const args = storeUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(args.create.status).toBe("KNOWN");
  });

  it("does not re-create a candidate that discovery already found", async () => {
    fetchStores.mockResolvedValue([withIg("zara_kz")]);
    candFindMany.mockResolvedValue([{ handle: "zara_kz" }]);

    const result = await runGisDiscovery(APORT_WEST);

    expect(candUpsert).not.toHaveBeenCalled();
    expect(result.alreadyKnown).toBe(1);
  });

  it("counts two outlets of one brand as a single candidate", async () => {
    fetchStores.mockResolvedValue([
      withIg("zara_kz", { gisId: "g1" }),
      withIg("zara_kz", { gisId: "g2" }),
    ]);

    const result = await runGisDiscovery(APORT_WEST);

    expect(candUpsert).toHaveBeenCalledTimes(1);
    expect(result.newCandidates).toBe(1);
    // Both storefronts are still recorded.
    expect(storeUpsert).toHaveBeenCalledTimes(2);
  });

  it("upserts an existing store by gisId rather than duplicating it", async () => {
    fetchStores.mockResolvedValue([store()]);
    await runGisDiscovery(APORT_WEST);
    expect((storeUpsert.mock.calls[0]?.[0] as { where: unknown }).where).toEqual({ gisId: "g1" });
  });
});

describe("rubric filtering keeps non-fashion out of the pipeline", () => {
  it("never creates candidates for restaurants, banks or cinemas", async () => {
    fetchStores.mockResolvedValue([
      withIg("cafe_kz", { gisId: "c1", rubric: "Кафе" }),
      withIg("bank_kz", { gisId: "b1", rubric: "Банк" }),
      withIg("zara_kz", { gisId: "z1", rubric: "Магазин одежды" }),
    ]);

    const result = await runGisDiscovery(APORT_WEST);

    expect(candUpsert).toHaveBeenCalledTimes(1);
    expect((candUpsert.mock.calls[0]?.[0] as { create: { handle: string } }).create.handle).toBe(
      "zara_kz",
    );
    expect(result).toMatchObject({ storesFound: 3, relevantStores: 1, filteredOut: 2 });
  });
});

describe("Apify fallback", () => {
  it("engages only when the API returned no Instagram at all", async () => {
    fetchStores.mockResolvedValue([store({ gisId: "g1" })]); // API: no contacts
    fallbackFetchStores.mockResolvedValue([withIg("zara_kz")]);
    fallbackHolder.value = { name: "apify", fetchStores: fallbackFetchStores };

    const result = await runGisDiscovery(APORT_WEST);

    expect(fallbackFetchStores).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ usedFallback: true, source: "apify", newCandidates: 1 });
  });

  it("does NOT engage when the API already produced Instagram links", async () => {
    fetchStores.mockResolvedValue([withIg("zara_kz")]);
    fallbackHolder.value = { name: "apify", fetchStores: fallbackFetchStores };

    const result = await runGisDiscovery(APORT_WEST);

    expect(fallbackFetchStores).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(false);
  });

  it("keeps the primary results when the fallback fails", async () => {
    fetchStores.mockResolvedValue([store()]);
    fallbackFetchStores.mockRejectedValue(new Error("apify down"));
    fallbackHolder.value = { name: "apify", fetchStores: fallbackFetchStores };

    const result = await runGisDiscovery(APORT_WEST);

    expect(result).toMatchObject({ usedFallback: false, storesFound: 1, noInstagram: 1 });
  });
});

describe("the 2GIS run stays outside the AI and publishing budgets", () => {
  it("passes an explicit test limit down to the source", async () => {
    fetchStores.mockResolvedValue([]);
    await runGisDiscovery(APORT_WEST, { limit: 25 });
    expect(fetchStores.mock.calls[0]?.[1]).toMatchObject({ limit: 25 });
  });

  it("leaves the existing daily limits untouched", () => {
    expect(DEFAULT_DAILY_ANALYSIS_LIMIT).toBe(20);
    expect(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT).toBe(20);
    expect(DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS).toBe(5_000);
  });
});
