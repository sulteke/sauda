import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GisApiStoreSource, MAX_PAGE_SIZE } from "./gis-api-source";
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

  it("never exceeds the API's maximum page size", async () => {
    fetchMock.mockResolvedValue(ok([item()]));
    await source().fetchStores(LOCATION);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`page_size=${MAX_PAGE_SIZE}`);
  });
});

describe("pagination", () => {
  it("walks every page until the reported total is covered", async () => {
    const page = (n: number) =>
      Array.from({ length: MAX_PAGE_SIZE }, (_, i) => item({ id: `p${n}-${i}`, name: `S${n}-${i}` }));
    fetchMock
      .mockResolvedValueOnce(ok(page(1), 120))
      .mockResolvedValueOnce(ok(page(2), 120))
      .mockResolvedValueOnce(ok(page(3).slice(0, 20), 120));

    const stores = await source().fetchStores(LOCATION);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stores).toHaveLength(120);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");
  });

  it("stops early on an empty page even if total disagrees", async () => {
    fetchMock.mockResolvedValueOnce(ok([item()], 500)).mockResolvedValueOnce(ok([], 500));

    const stores = await source().fetchStores(LOCATION);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stores).toHaveLength(1);
  });

  it("honors an explicit test limit without fetching more pages", async () => {
    fetchMock.mockResolvedValue(ok([item({ id: "a" }), item({ id: "b" })], 999));

    const stores = await source().fetchStores(LOCATION, { limit: 2 });

    expect(stores).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page_size=2");
  });

  it("deduplicates a store repeated across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(ok([item({ id: "dup" })], 100))
      .mockResolvedValueOnce(ok([item({ id: "dup" })], 100))
      .mockResolvedValueOnce(ok([], 100));

    const stores = await source().fetchStores(LOCATION);
    expect(stores).toHaveLength(1);
  });

  it("caps the number of pages so a bad total cannot loop forever", async () => {
    fetchMock.mockResolvedValue(ok([item({ id: `x${Math.random()}` })], 10_000_000));
    const stores = await source().fetchStores(LOCATION, { maxPages: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stores.length).toBeLessThanOrEqual(3);
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
    expect(await source().fetchStores(LOCATION)).toHaveLength(1);
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

  it("treats a 404 past the first page as the end of results", async () => {
    fetchMock.mockResolvedValueOnce(ok([item()], 999)).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ meta: { code: 404 } }),
    } as unknown as Response);

    expect(await source().fetchStores(LOCATION)).toHaveLength(1);
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
