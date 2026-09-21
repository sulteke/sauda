import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GisApifyStoreSource } from "./gis-apify-source";
import { parseGisLocation } from "./gis-location";
import { isFashionRubric, partitionByRubric } from "./gis-rubric-filter";
import { GisLocationError, GisSourceError } from "./gis-store-source";
import { buildGisStoreSource, configuredGisSource } from "./resolve-gis-store-source";

const LOCATION = { kind: "building" as const, id: "9430047375099302" };

const ENV_KEYS = ["GIS_STORE_SOURCE", "GIS_API_KEY", "APIFY_TOKEN", "APIFY_2GIS_ACTOR"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseGisLocation", () => {
  it("accepts a bare building id", () => {
    expect(parseGisLocation("9430047375099302")).toEqual({
      kind: "building",
      id: "9430047375099302",
      name: undefined,
    });
  });

  it("accepts an /inside/ venue URL", () => {
    expect(parseGisLocation("https://2gis.kz/almaty/inside/9430047375099302")).toMatchObject({
      kind: "building",
      id: "9430047375099302",
    });
  });

  it("accepts a /geo/ URL as a place (territory)", () => {
    expect(parseGisLocation("https://2gis.kz/almaty/geo/70030076378089101")).toMatchObject({
      kind: "place",
      id: "70030076378089101",
    });
  });

  it("accepts an explicit prefix", () => {
    expect(parseGisLocation("place:123456789")).toMatchObject({ kind: "place", id: "123456789" });
  });

  it("rejects a firm link with guidance — one business is not a venue", () => {
    expect(() => parseGisLocation("https://2gis.kz/almaty/firm/9429940000817186")).toThrow(
      /not a venue/i,
    );
  });

  it("rejects junk and empty input", () => {
    expect(() => parseGisLocation("")).toThrow(GisLocationError);
    expect(() => parseGisLocation("aport mall")).toThrow(GisLocationError);
    expect(() => parseGisLocation("https://example.com/inside/123456789")).toThrow(GisLocationError);
  });

  it("carries the venue name through", () => {
    expect(parseGisLocation("9430047375099302", "Aport Mall West").name).toBe("Aport Mall West");
  });
});

describe("rubric filtering", () => {
  it("accepts fashion retail", () => {
    for (const rubric of [
      "Магазин одежды",
      "Магазин обуви",
      "Детская одежда",
      "Спортивная одежда",
      "Аксессуары и бижутерия",
      "Ювелирный магазин",
      "Сумки",
      "Clothing store",
    ]) {
      expect(isFashionRubric(rubric), rubric).toBe(true);
    }
  });

  it("rejects everything a mall has that is not fashion retail", () => {
    for (const rubric of [
      "Кафе",
      "Быстрое питание",
      "Банк",
      "Банкомат",
      "Кинотеатр",
      "Аптека",
      "Супермаркет",
      "Салон связи",
      "Компьютерный клуб",
    ]) {
      expect(isFashionRubric(rubric), rubric).toBe(false);
    }
  });

  it("rejects fashion-adjacent SERVICES, not just unrelated rubrics", () => {
    expect(isFashionRubric("Ремонт обуви")).toBe(false);
    expect(isFashionRubric("Ателье по пошиву одежды")).toBe(false);
    expect(isFashionRubric("Химчистка одежды")).toBe(false);
    expect(isFashionRubric("Прокат одежды")).toBe(false);
  });

  it("does not let a fashion stem match inside an unrelated word", () => {
    // Regression from a real Aport run: "бель" (нижнее бельё) matched "мебель".
    expect(isFashionRubric("Офисная мебель")).toBe(false);
    expect(isFashionRubric("Мебельный магазин")).toBe(false);
    expect(isFashionRubric("Нижнее бельё")).toBe(true);
  });

  it("accepts the rubrics a real Aport Mall West run returned", () => {
    for (const rubric of [
      "Мужская одежда",
      "Женская одежда",
      "Детская одежда",
      "Обувные магазины",
      "Детская обувь",
      "Спортивная одежда и обувь",
      "Ювелирные изделия",
      "Бижутерия",
      "Носки и колготки",
    ]) {
      expect(isFashionRubric(rubric), rubric).toBe(true);
    }
    for (const rubric of ["Быстрое питание", "Банки", "Мобильные операторы", "Оптика", "Офисная мебель"]) {
      expect(isFashionRubric(rubric), rubric).toBe(false);
    }
  });

  it("treats a missing rubric as not relevant — silence is not evidence", () => {
    expect(isFashionRubric(null)).toBe(false);
    expect(isFashionRubric(undefined)).toBe(false);
    expect(isFashionRubric("")).toBe(false);
  });

  it("partitions a mixed venue", () => {
    const { relevant, excluded } = partitionByRubric([
      { rubric: "Магазин одежды" },
      { rubric: "Кафе" },
      { rubric: "Магазин обуви" },
      { rubric: "Банк" },
      { rubric: null },
    ]);
    expect(relevant).toHaveLength(2);
    expect(excluded).toHaveLength(3);
  });
});

describe("source switching", () => {
  it("defaults to the official API", () => {
    delete process.env.GIS_STORE_SOURCE;
    expect(configuredGisSource()).toBe("api");
  });

  it("switches to apify only on an explicit opt-in", () => {
    process.env.GIS_STORE_SOURCE = "apify";
    expect(configuredGisSource()).toBe("apify");
    process.env.GIS_STORE_SOURCE = "API";
    expect(configuredGisSource()).toBe("api");
    process.env.GIS_STORE_SOURCE = "nonsense";
    expect(configuredGisSource()).toBe("api");
  });

  it("builds each source behind the SAME interface", () => {
    process.env.GIS_API_KEY = "k";
    process.env.APIFY_TOKEN = "t";
    process.env.APIFY_2GIS_ACTOR = "acme~2gis";

    const api = buildGisStoreSource("api");
    const apify = buildGisStoreSource("apify");

    expect(api.name).toBe("api");
    expect(apify.name).toBe("apify");
    for (const source of [api, apify]) {
      expect(typeof source.fetchStores).toBe("function");
    }
  });

  it("explains exactly which env var is missing", () => {
    delete process.env.GIS_API_KEY;
    expect(() => buildGisStoreSource("api")).toThrow(/GIS_API_KEY/);

    delete process.env.APIFY_TOKEN;
    expect(() => buildGisStoreSource("apify")).toThrow(/APIFY_TOKEN/);

    process.env.APIFY_TOKEN = "t";
    delete process.env.APIFY_2GIS_ACTOR;
    expect(() => buildGisStoreSource("apify")).toThrow(/APIFY_2GIS_ACTOR/);
  });
});

describe("Apify 2GIS source", () => {
  function apifyOk(items: unknown[]) {
    return { ok: true, status: 200, json: async () => items } as unknown as Response;
  }

  it("calls the CONFIGURED actor, never a hardcoded one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apifyOk([]));
    vi.stubGlobal("fetch", fetchMock);

    await new GisApifyStoreSource({ token: "tok", actorId: "custom~actor" }).fetchStores(LOCATION);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("custom~actor");
  });

  it("normalizes varied actor payloads into the shared shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apifyOk([
          {
            id: 70000001,
            title: "Zara",
            fullAddress: "Ташкентский тракт, 17к",
            phones: ["+7 700 000 00 00"],
            website: "https://zara.kz",
            socialLinks: { instagram: "https://instagram.com/zara_kz" },
            category: "Магазин одежды",
            lat: 43.2,
            lon: 76.7,
          },
        ]),
      ),
    );

    const [store] = await new GisApifyStoreSource({
      token: "tok",
      actorId: "a~b",
    }).fetchStores(LOCATION);

    expect(store).toMatchObject({
      gisId: "70000001",
      name: "Zara",
      address: "Ташкентский тракт, 17к",
      phone: "+7 700 000 00 00",
      website: "https://zara.kz",
      instagramHandle: "zara_kz",
      rubric: "Магазин одежды",
      latitude: 43.2,
      longitude: 76.7,
      locationId: "9430047375099302",
    });
  });

  it("finds Instagram nested anywhere in the payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apifyOk([
          { id: "1", name: "Shop", contacts: [{ kind: "social", href: "instagram.com/deep_kz" }] },
        ]),
      ),
    );

    const [store] = await new GisApifyStoreSource({ token: "t", actorId: "a~b" }).fetchStores(
      LOCATION,
    );
    expect(store?.instagramHandle).toBe("deep_kz");
  });

  it("leaves Instagram null rather than guessing from the name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apifyOk([{ id: "1", name: "Zara Almaty" }])));

    const [store] = await new GisApifyStoreSource({ token: "t", actorId: "a~b" }).fetchStores(
      LOCATION,
    );
    expect(store?.instagramHandle).toBeNull();
    expect(store?.instagramUrl).toBeNull();
  });

  it("deduplicates and honors the limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apifyOk([
          { id: "1", name: "A" },
          { id: "1", name: "A again" },
          { id: "2", name: "B" },
          { id: "3", name: "C" },
        ]),
      ),
    );

    const stores = await new GisApifyStoreSource({ token: "t", actorId: "a~b" }).fetchStores(
      LOCATION,
      { limit: 2 },
    );
    expect(stores.map((s) => s.gisId)).toEqual(["1", "2"]);
  });

  it("wraps an actor failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        statusText: "Payment Required",
        text: async () => "usage limit",
      } as unknown as Response),
    );

    await expect(
      new GisApifyStoreSource({ token: "t", actorId: "a~b" }).fetchStores(LOCATION),
    ).rejects.toBeInstanceOf(GisSourceError);
  });
});
