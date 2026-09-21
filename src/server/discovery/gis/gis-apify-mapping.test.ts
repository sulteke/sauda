import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GisApifyStoreSource } from "./gis-apify-source";
import { isFashionStore, partitionByRubric } from "./gis-rubric-filter";
import type { GisStore } from "./gis-store-source";

/**
 * Regression suite built from a REAL m_mamaev/2gis-places-scraper response for
 * Aport Mall West (building 9430047375099302), captured on a live 5-item run.
 *
 * Every shape here caused a real mapping bug: contacts arrive as arrays, the
 * human-readable categories live in `rubrics` while `category` holds an
 * internal code ("common_store"), coordinates sit under `location.lat/lng`,
 * and Instagram is filed under `socials.other[]` beside VK and Telegram.
 */

const LOCATION = { kind: "building" as const, id: "9430047375099302", name: "Aport Mall West" };

/** Verbatim field shapes from the live run. */
const RESERVED = {
  id: "70000001036710034",
  title: "Reserved, магазин",
  address: "Ташкентский тракт, 17к",
  rubrics: ["Женская одежда", "Мужская одежда", "Детская одежда", "Сумки и кожгалантерея", "Обувные магазины"],
  category: "common_store",
  phoneText: ["+7‒771‒070‒85‒34"],
  phoneValue: ["+77710708534"],
  website: [] as string[],
  socials: { other: ["https://instagram.com/reserved"] },
  location: { lat: 43.233, lng: 76.776 },
  url: "https://2gis.kz/almaty/firm/70000001036710034",
};

const KIMEX = {
  id: "70000001047477742",
  title: "Kimex, магазин",
  address: "Ташкентский тракт, 17к",
  rubrics: ["Обувные магазины", "Женская одежда", "Мужская одежда", "Сумки и кожгалантерея", "Верхняя одежда"],
  category: "common_store",
  phoneText: ["+7‒771‒743‒77‒93", "+7‒701‒081‒25‒51"],
  website: ["http://kimex.kz"],
  socials: {
    whatsapp: ["https://wa.me/77717437793"],
    other: ["https://instagram.com/kimex_grazie", "https://facebook.com/kimex.grazie.kazakhstan"],
  },
  location: { lat: 43.233533, lng: 76.776002 },
  url: "https://2gis.kz/almaty/firm/70000001047477742",
};

const MAGNUM = {
  id: "70000001030384191",
  title: "Magnum Сash & Сarry, супермаркет",
  address: "Ташкентский тракт, 17к",
  rubrics: ["Супермаркеты"],
  category: "mart",
  phoneText: ["7766", "7772"],
  socials: {
    telegram: ["https://t.me/magnumsafescan_bot"],
    other: ["https://instagram.com/magnum.kz", "https://youtube.com/@MagnumCashCarrykz"],
  },
  location: { lat: 43.234, lng: 76.775 },
  url: "https://2gis.kz/almaty/firm/70000001030384191",
};

/** Cosmetics shop that also stocks hosiery — a secondary-rubric trap. */
const DIONA = {
  id: "70000001103886456",
  title: "Диона, магазин",
  rubrics: ["Косметика и парфюмерия", "Бытовая химия", "Носки и колготки", "Средства гигиены"],
  category: "common_store",
  website: ["http://dionashop.kz"],
  socials: { other: ["https://instagram.com/dionashop.kz"] },
  location: { lat: 43.233, lng: 76.776 },
};

async function normalize(items: unknown[]): Promise<GisStore[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => items } as never),
  );
  return new GisApifyStoreSource({ token: "t", actorId: "a~b" }).fetchStores(LOCATION);
}

const byName = (stores: GisStore[], prefix: string) =>
  stores.find((s) => s.name.startsWith(prefix))!;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram from socials.other[]", () => {
  it("finds it beside VK / Telegram / WhatsApp entries", async () => {
    const stores = await normalize([RESERVED, KIMEX, MAGNUM]);
    expect(byName(stores, "Reserved").instagramHandle).toBe("reserved");
    expect(byName(stores, "Kimex").instagramHandle).toBe("kimex_grazie");
    expect(byName(stores, "Magnum").instagramHandle).toBe("magnum.kz");
  });

  it("builds the canonical profile URL", async () => {
    const [store] = await normalize([RESERVED]);
    expect(store?.instagramUrl).toBe("https://www.instagram.com/reserved");
  });

  it("ignores non-Instagram socials in the same array", async () => {
    const [store] = await normalize([KIMEX]);
    // facebook.com and wa.me sit beside it and must not be mistaken for it.
    expect(store?.instagramHandle).toBe("kimex_grazie");
  });

  it("leaves it null when the store has no social links", async () => {
    const [store] = await normalize([{ id: "1", title: "Плейн", rubrics: ["Женская одежда"] }]);
    expect(store?.instagramHandle).toBeNull();
    expect(store?.instagramUrl).toBeNull();
  });
});

describe("website arrives as an array", () => {
  it("reads the real site out of website[]", async () => {
    const [store] = await normalize([KIMEX]);
    expect(store?.website).toBe("http://kimex.kz");
  });

  it("never files the 2GIS listing page as the store's website", async () => {
    // Reserved has an empty website[] but a `url` pointing at 2gis.kz.
    const [store] = await normalize([RESERVED]);
    expect(store?.website).toBeNull();
    expect(store?.gisUrl).toContain("2gis.kz");
  });

  it("still accepts a plain-string website from another actor", async () => {
    const [store] = await normalize([{ id: "1", title: "X", website: "https://x.kz" }]);
    expect(store?.website).toBe("https://x.kz");
  });
});

describe("phoneText[] and coordinates", () => {
  it("reads the first phone out of phoneText[]", async () => {
    expect((await normalize([KIMEX]))[0]?.phone).toBe("+7‒771‒743‒77‒93");
    expect((await normalize([RESERVED]))[0]?.phone).toBe("+7‒771‒070‒85‒34");
  });

  it("reads coordinates from location.lat / location.lng", async () => {
    const [store] = await normalize([KIMEX]);
    expect(store?.latitude).toBe(43.233533);
    expect(store?.longitude).toBe(76.776002);
  });

  it("still accepts flat lat/lon from another actor", async () => {
    const [store] = await normalize([{ id: "1", title: "X", lat: 1.5, lon: 2.5 }]);
    expect(store?.latitude).toBe(1.5);
    expect(store?.longitude).toBe(2.5);
  });
});

describe("rubrics drive the fashion filter, never the internal category code", () => {
  it("maps the human-readable rubrics, primary first", async () => {
    const [store] = await normalize([RESERVED]);
    expect(store?.rubric).toBe("Женская одежда");
    expect(store?.rubrics).toEqual(RESERVED.rubrics);
    // "common_store" must never surface as the rubric.
    expect(store?.rubric).not.toBe("common_store");
  });

  it("classifies the real Aport stores correctly", async () => {
    const stores = await normalize([RESERVED, KIMEX, MAGNUM, DIONA]);
    expect(isFashionStore(byName(stores, "Reserved"))).toBe(true);
    expect(isFashionStore(byName(stores, "Kimex"))).toBe(true);
    expect(isFashionStore(byName(stores, "Magnum"))).toBe(false);
    // Cosmetics shop: "Носки и колготки" is a secondary rubric, not its identity.
    expect(isFashionStore(byName(stores, "Диона"))).toBe(false);
  });

  it("partitions a real mixed venue", async () => {
    const stores = await normalize([RESERVED, KIMEX, MAGNUM, DIONA]);
    const { relevant, excluded } = partitionByRubric(stores);
    expect(relevant.map((s) => s.name.split(",")[0])).toEqual(["Reserved", "Kimex"]);
    expect(excluded).toHaveLength(2);
  });

  it("keeps the мебель regression: a fashion stem inside another word", async () => {
    const stores = await normalize([
      { id: "1", title: "Zeta", rubrics: ["Офисная мебель"] },
      { id: "2", title: "Бельё", rubrics: ["Нижнее бельё"] },
    ]);
    expect(isFashionStore(stores[0]!)).toBe(false);
    expect(isFashionStore(stores[1]!)).toBe(true);
  });

  it("would have classified everything as non-fashion before the fix", () => {
    // The old code read `category`; both real fashion stores carried the same
    // internal code as the supermarket, so the filter could not tell them apart.
    expect(RESERVED.category).toBe(KIMEX.category);
    expect(isFashionStore({ rubric: "common_store" })).toBe(false);
  });
});
