import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseGisInput,
  parseGisLocation,
  resolveFirmBuilding,
  resolveGisLocation,
  resolveShortLink,
} from "./gis-location";
import { GisLocationError } from "./gis-store-source";

const APORT_WEST = "9430047375099302";
const MOSKVA_FIRM = "70000001024389555";
const MOSKVA_BUILDING = "9430047375177300";

/** A 302 with a Location header, as go.2gis.com answers. */
const redirect = (location: string | null, status = 302) =>
  ({ status, headers: new Headers(location ? { location } : {}) }) as unknown as Response;

/** A Places API byid response. */
const byId = (address: Record<string, unknown> | null, name = "MOSKVA Metropolitan") =>
  ({
    status: 200,
    json: async () => ({ meta: { code: 200 }, result: { items: [{ name, address }] } }),
  }) as unknown as Response;

const KEYS = ["GIS_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.GIS_API_KEY = "test-key";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("inputs that need no network", () => {
  it("still accepts a bare numeric building id", async () => {
    const fetchImpl = vi.fn();
    await expect(resolveGisLocation(APORT_WEST, { fetchImpl })).resolves.toMatchObject({
      kind: "building",
      id: APORT_WEST,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still accepts an /inside/<id> venue URL", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveGisLocation(`https://2gis.kz/almaty/inside/${APORT_WEST}`, { fetchImpl }),
    ).resolves.toMatchObject({ kind: "building", id: APORT_WEST });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still accepts /geo/<id> as a place and an explicit prefix", async () => {
    await expect(resolveGisLocation("https://2gis.kz/almaty/geo/70030076378089101")).resolves.toMatchObject({
      kind: "place",
      id: "70030076378089101",
    });
    await expect(resolveGisLocation("place:123456789")).resolves.toMatchObject({ kind: "place" });
  });

  it("carries the venue name through", async () => {
    const r = await resolveGisLocation(APORT_WEST, { name: "Aport Mall West" });
    expect(r.name).toBe("Aport Mall West");
  });

  it("rejects junk with guidance", () => {
    expect(() => parseGisInput("")).toThrow(GisLocationError);
    expect(() => parseGisInput("aport mall")).toThrow(/share link|building id/i);
    expect(() => parseGisInput("https://example.com/inside/123456789")).toThrow(GisLocationError);
  });
});

describe("go.2gis.com share links", () => {
  it("classifies a share link without touching the network", () => {
    expect(parseGisInput("https://go.2gis.com/rTTDK")).toEqual({
      kind: "short",
      url: "https://go.2gis.com/rTTDK",
    });
  });

  it("reads ONLY the first redirect and never follows to the anti-bot page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(`https://2gis.kz/almaty/inside/${APORT_WEST}`));

    const location = await resolveGisLocation("https://go.2gis.com/aBcDe", { fetchImpl });

    expect(location).toMatchObject({ kind: "building", id: APORT_WEST });
    // One hop only, and redirects are not followed by fetch itself.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("never requests the /museum interstitial", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(`https://2gis.kz/almaty/firm/${MOSKVA_FIRM}/76.8,43.2`))
      .mockResolvedValueOnce(byId({ building_id: MOSKVA_BUILDING }));

    await resolveGisLocation("https://go.2gis.com/rTTDK", { fetchImpl });

    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/museum"))).toBe(false);
    expect(urls.some((u) => u.includes("return_url"))).toBe(false);
  });

  it("resolves a relative Location header against the short link", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(`/almaty/inside/${APORT_WEST}`));
    await expect(
      resolveGisLocation("https://go.2gis.com/aBcDe", { fetchImpl }),
    ).rejects.toBeInstanceOf(GisLocationError); // go.2gis.com is not a venue host
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("errors clearly when the link does not redirect", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(null, 200));
    await expect(
      resolveGisLocation("https://go.2gis.com/broken", { fetchImpl }),
    ).rejects.toThrow(/did not redirect/i);
  });

  it("errors clearly when the share link has no code", () => {
    expect(() => parseGisInput("https://go.2gis.com/")).toThrow(/no code/i);
  });

  it("surfaces a network failure as a readable error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(
      resolveShortLink("https://go.2gis.com/x", { fetchImpl }),
    ).rejects.toThrow(/Could not follow the 2GIS share link/);
  });
});

describe("firm → building", () => {
  it("resolves the real rTTDK chain: firm 70000001024389555 → building 9430047375177300", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        redirect(`https://2gis.kz/almaty/firm/${MOSKVA_FIRM}/76.86395,43.227292?m=76.8,43.2/18`),
      )
      .mockResolvedValueOnce(
        byId({ building_id: MOSKVA_BUILDING, building_name: "ТРЦ MOSKVA Metropolitan" }),
      );

    const location = await resolveGisLocation("https://go.2gis.com/rTTDK", { fetchImpl });

    expect(location).toEqual({
      kind: "building",
      id: MOSKVA_BUILDING,
      name: "ТРЦ MOSKVA Metropolitan",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(`/3.0/items/byid?id=${MOSKVA_FIRM}`);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("fields=items.address");
  });

  it("resolves a pasted /firm/ URL directly, without a share link", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(byId({ building_id: MOSKVA_BUILDING }));
    const location = await resolveGisLocation(`https://2gis.kz/almaty/firm/${MOSKVA_FIRM}`, {
      fetchImpl,
    });
    expect(location.id).toBe(MOSKVA_BUILDING);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no short-link hop needed
  });

  it("explains that GIS_API_KEY is required when it is missing", async () => {
    delete process.env.GIS_API_KEY;
    const fetchImpl = vi.fn();
    await expect(
      resolveFirmBuilding(MOSKVA_FIRM, { fetchImpl }),
    ).rejects.toThrow(/GIS_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled(); // fails before spending a request
  });

  it("errors clearly when the business has no building on 2GIS", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(byId({}, "Уличный киоск"));
    await expect(resolveFirmBuilding(MOSKVA_FIRM, { fetchImpl })).rejects.toThrow(
      /no building recorded for "Уличный киоск"/,
    );
  });

  it("errors clearly when 2GIS does not know the id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({ meta: { code: 404, error: { message: "Not found" } } }),
    } as unknown as Response);
    await expect(resolveFirmBuilding("123456789", { fetchImpl })).rejects.toThrow(/404.*Not found/);
  });

  it("prefers a caller-supplied name over the building name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(byId({ building_id: MOSKVA_BUILDING, building_name: "ТРЦ" }));
    const location = await resolveFirmBuilding(MOSKVA_FIRM, { fetchImpl, name: "My Mall" });
    expect(location.name).toBe("My Mall");
  });

  it("never puts the API key anywhere but the query string", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(byId({ building_id: MOSKVA_BUILDING }));
    await resolveFirmBuilding(MOSKVA_FIRM, { fetchImpl, apiKey: "super-secret" });
    expect(JSON.stringify(fetchImpl.mock.calls[0]?.[1] ?? {})).not.toContain("super-secret");
  });
});

describe("parseGisLocation (sync back-compat)", () => {
  it("returns venues directly", () => {
    expect(parseGisLocation(APORT_WEST)).toMatchObject({ kind: "building", id: APORT_WEST });
  });

  it("refuses inputs that need resolving", () => {
    expect(() => parseGisLocation("https://go.2gis.com/rTTDK")).toThrow(/resolved/i);
    expect(() => parseGisLocation(`https://2gis.kz/almaty/firm/${MOSKVA_FIRM}`)).toThrow(/resolved/i);
  });
});
