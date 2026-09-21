import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PAGE_SIZE, GisApiStoreSource, MAX_PAGE_SIZE } from "./gis-api-source";
import { FASHION_QUERIES } from "./gis-rubric-filter";
import { extractInstagramHandle, GisSourceError } from "./gis-store-source";

const LOCATION = { kind: "building" as const, id: "9430047375099302", name: "Aport Mall West" };

/** One 2GIS item; `contacts` mirrors the nested contact_groups shape. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: "70000001",
    name: "Zara",
    address_name: "Ташкентский тракт, 17к",
    point: { lat: 43.2, lon: 76.7 },
    rubrics: [{ name: "Магазин одежды" }],
    ...over,
  };
}

function ok(items: unknown[], total = items.length) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ meta: { code: 200 }, result: { total, items } }),
  } as unknown as Response;
}

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

const source = () => new GisApiStoreSource({ apiKey: "secret-key" });

describe("2GIS Places API request", () => {
  it("filters by building_id and asks for contact groups", async () => {
    fetchMock.mockResolvedValue(ok([item()]));

    await source().fetchStores(LOCATION);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/3.0/items");
    expect(url).toContain("building_id=9430047375099302");
    expect(url).toContain("type=branch");
    expect(url).toContain("items.contact_groups");
  });

  it("uses place_id for a territory rather than a building", async () => {
    fetchMock.mockResolvedValue(ok([item()]));

    await source().fetchStores({ kind: "place", id: "123456789" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("place_id=123456789");
  });

  it("requests the page size every plan accepts", async () => {
    fetchMock.mockResolvedValue(ok([item()]));
    await source().fetchStores(LOCATION);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`page_size=${DEFAULT_PAGE_SIZE}`);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it("steps down once when the plan rejects the configured page size", async () => {
    process.env.GIS_PAGE_SIZE = "50";
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          meta: { code: 400, error: { message: "Length of parameter 'page_size' should be from 1 to 10" } },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce(ok([item()]))
      .mockResolvedValue(ok([]));

    const stores = await source().fetchStores(LOCATION);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page_size=50");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`page_size=${DEFAULT_PAGE_SIZE}`);
    expect(stores).toHaveLength(1);
    delete process.env.GIS_PAGE_SIZE;
  });
});

describe("pagination and query partitioning", () => {
  const page = (n: number) =>
    Array.from({ length: DEFAULT_PAGE_SIZE }, (_, i) => item({ id: `p${n}-${i}`, name: `S${n}-${i}` }));

  it("walks every page until the venue total is covered, then stops", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(page(1), 25))
      .mockResolvedValueOnce(ok(page(2), 25))
      .mockResolvedValueOnce(ok(page(3).slice(0, 5), 25));

    const stores = await source().fetchStores(LOCATION);

    // The whole venue fit inside the first query, so no partitioning was needed.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stores).toHaveLength(25);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");
  });

  it("partitions the venue into fashion queries when one window is too small", async () => {
    let n = 0;
    fetchMock.mockImplementation(() => Promise.resolve(ok(page(n++), 281)));

    const stores = await source().fetchStores(LOCATION, { maxPages: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(FASHION_QUERIES.length);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).not.toContain("q=");
    expect(urls.filter((u) => u.includes("q=")).length).toBe(FASHION_QUERIES.length - 1);
    expect(stores.length).toBeGreaterThan(DEFAULT_PAGE_SIZE);
  });

  it("deduplicates the same store returned by several queries", async () => {
    fetchMock.mockResolvedValue(ok([item({ id: "dup" })], 281));

    const stores = await source().fetchStores(LOCATION);

    expect(stores).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(FASHION_QUERIES.length);
  });

  it("stops a query early on an empty page even if total disagrees", async () => {
    fetchMock
      .mockResolvedValueOnce(ok([item()], 500))
      .mockResolvedValueOnce(ok([], 500))
      .mockResolvedValue(ok([], 0));

    const stores = await source().fetchStores(LOCATION);

    expect(stores).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(FASHION_QUERIES.length + 1);
  });

  it("honors an explicit test limit and stops querying entirely", async () => {
    fetchMock.mockResolvedValue(ok([item({ id: "a" }), item({ id: "b" })], 999));

    const stores = await source().fetchStores(LOCATION, { limit: 2 });

    expect(stores).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page_size=2");
  });

  it("caps pages per query so a bad total cannot loop forever", async () => {
    let n = 0;
    fetchMock.mockImplementation(() => Promise.resolve(ok(page(n++), 10_000_000)));

    await source().fetchStores(LOCATION, { maxPages: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(FASHION_QUERIES.length * 2);
  });

  it("treats a refused page as the end of that query's window, not a failure", async () => {
    // A demo key rejects page > 5; the remaining queries must still run.
    fetchMock
      .mockResolvedValueOnce(ok(page(1), 281))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          meta: { code: 400, error: { message: "Length of parameter 'page' should be from 1 to 5" } },
        }),
      } as unknown as Response)
      .mockResolvedValue(ok([], 0));

    const stores = await source().fetchStores(LOCATION);

    expect(stores).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("normalization", () => {
  it("maps a 2GIS item onto the shared store shape", async () => {
    fetchMock.mockResolvedValue(ok([item()]));

    const [store] = await source().fetchStores(LOCATION);

    expect(store).toMatchObject({
      gisId: "70000001",
      name: "Zara",
      address: "Ташкентский тракт, 17к",
      rubric: "Магазин одежды",
      latitude: 43.2,
      longitude: 76.7,
      locationId: "9430047375099302",
      locationName: "Aport Mall West",
    });
    expect(store?.gisUrl).toContain("70000001");
  });

  it("extracts website, phone and Instagram from contact groups", async () => {
    fetchMock.mockResolvedValue(
      ok([
        item({
          contact_groups: [
            {
              contacts: [
                { type: "phone", value: "+7 700 000 00 00" },
                { type: "website", value: "https://zara.kz" },
                { type: "instagram", url: "https://instagram.com/zara_kz" },
              ],
            },
          ],
        }),
      ]),
    );

    const [store] = await source().fetchStores(LOCATION);

    expect(store?.phone).toBe("+7 700 000 00 00");
    expect(store?.website).toBe("https://zara.kz");
    expect(store?.instagramHandle).toBe("zara_kz");
    expect(store?.instagramUrl).toBe("https://www.instagram.com/zara_kz");
  });

  it("finds Instagram even when filed under a generic contact type", async () => {
    fetchMock.mockResolvedValue(
      ok([
        item({
          contact_groups: [
            { contacts: [{ type: "social", text: "Мы тут: instagram.com/almaty.shop" }] },
          ],
        }),
      ]),
    );

    expect((await source().fetchStores(LOCATION))[0]?.instagramHandle).toBe("almaty.shop");
  });

  it("never files an Instagram link as the website", async () => {
    fetchMock.mockResolvedValue(
      ok([
        item({
          contact_groups: [
            { contacts: [{ type: "website", value: "https://instagram.com/only_ig" }] },
          ],
        }),
      ]),
    );

    const [store] = await source().fetchStores(LOCATION);
    expect(store?.website).toBeNull();
    expect(store?.instagramHandle).toBe("only_ig");
  });

  it("returns no contacts when the key lacks the paid permission", async () => {
    // 2GIS simply omits contact_groups; nothing is invented from the name.
    fetchMock.mockResolvedValue(ok([item()]));

    const [store] = await source().fetchStores(LOCATION);
    expect(store?.instagramHandle).toBeNull();
    expect(store?.website).toBeNull();
  });

  it("drops items with no id or no name rather than inventing one", async () => {
    fetchMock.mockResolvedValue(ok([item({ id: undefined }), item({ name: "  " }), item()]));
    const stores = await source().fetchStores(LOCATION);
    expect(stores).toHaveLength(1);
    // Every remaining fashion query still ran despite the 404s.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(FASHION_QUERIES.length);
  });
});

describe("errors", () => {
  it("surfaces the 2GIS meta.code even on an HTTP 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ meta: { code: 403, error: { message: "Key is invalid" } } }),
    } as unknown as Response);

    await expect(source().fetchStores(LOCATION)).rejects.toBeInstanceOf(GisSourceError);
    await expect(source().fetchStores(LOCATION)).rejects.toThrow(/Key is invalid/);
  });

  it("treats 404 as \"nothing matched\", so one empty query cannot fail the run", async () => {
    fetchMock.mockResolvedValueOnce(ok([item()], 999)).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ meta: { code: 404 } }),
    } as unknown as Response);

    const stores = await source().fetchStores(LOCATION);
    expect(stores).toHaveLength(1);
    // Every remaining fashion query still ran despite the 404s.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(FASHION_QUERIES.length);
  });

  it("wraps a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(source().fetchStores(LOCATION)).rejects.toBeInstanceOf(GisSourceError);
  });

  it("never logs the API key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValue(ok([item()]));
    await source().fetchStores(LOCATION);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("secret-key");
  });
});

describe("extractInstagramHandle", () => {
  it("reads a handle from a URL, with or without protocol", () => {
    expect(extractInstagramHandle("https://www.instagram.com/qoima/")).toBe("qoima");
    expect(extractInstagramHandle("instagram.com/qoima")).toBe("qoima");
  });

  it("normalizes case", () => {
    expect(extractInstagramHandle("https://instagram.com/QoIMa")).toBe("qoima");
  });

  it("finds a URL embedded in free text", () => {
    expect(extractInstagramHandle("Заказы: https://instagram.com/shop_kz ежедневно")).toBe(
      "shop_kz",
    );
  });

  it("refuses to guess from a bare name — never a username", () => {
    expect(extractInstagramHandle("Zara Almaty")).toBeNull();
    expect(extractInstagramHandle("https://zara.kz")).toBeNull();
    expect(extractInstagramHandle("")).toBeNull();
    expect(extractInstagramHandle(null)).toBeNull();
  });

  it("rejects non-profile Instagram paths", () => {
    expect(extractInstagramHandle("https://instagram.com/p/Cabc123/")).toBeNull();
    expect(extractInstagramHandle("https://instagram.com/explore/tags/almaty/")).toBeNull();
  });
});
