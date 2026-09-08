import { describe, expect, it } from "vitest";

import type { InstagramExternalLink } from "@/types/instagram";

import { enrichBoutique, type EnrichmentInput } from "./boutique-enrichment";

const base = (over: Partial<EnrichmentInput>): EnrichmentInput => ({
  biography: null,
  externalUrl: null,
  externalUrls: [],
  businessAddress: null,
  ...over,
});

describe("enrichBoutique", () => {
  it("returns empty structures for empty input", () => {
    const e = enrichBoutique(base({}));
    expect(e).toMatchObject({
      phones: [],
      whatsapp: [],
      telegram: [],
      twoGis: [],
      googleMaps: [],
      website: null,
      taplink: null,
      city: null,
      address: null,
      deliveryRegions: [],
      businessHours: null,
    });
  });

  it("extracts city, address, hours, delivery and taplink from a real-style bio", () => {
    const e = enrichBoutique(
      base({
        biography:
          "Одеваем Алматы с 2016\nАбая 89  10:00-22:00\nТД Мерей 10:00-21:00\nДоставка по Казахстану",
        externalUrl: "https://seendicat.taplink.ws/",
        externalUrls: [{ title: null, url: "https://seendicat.taplink.ws/" }],
      }),
    );
    expect(e.city).toBe("Алматы");
    expect(e.address).toBe("Абая 89");
    expect(e.businessHours).toBe("10:00–22:00, 10:00–21:00");
    expect(e.deliveryRegions).toEqual(["Казахстану"]);
    expect(e.taplink).toBe("https://seendicat.taplink.ws/");
    expect(e.website).toBeNull(); // only a taplink → no separate website
  });

  it("normalizes phone numbers to +7 E.164", () => {
    const e = enrichBoutique(
      base({ biography: "Тел: +7 707 123 45 67\nЕщё: 8 (701) 555-00-11" }),
    );
    expect(e.phones).toEqual(["+77071234567", "+77015550011"]);
  });

  it("classifies WhatsApp / Telegram / 2GIS / Google Maps / website links", () => {
    const externalUrls: InstagramExternalLink[] = [
      { title: null, url: "https://wa.me/77015550000" },
      { title: "Site", url: "https://example.kz" },
      { title: null, url: "https://t.me/mychannel" },
      { title: null, url: "https://maps.app.goo.gl/abc" },
      { title: null, url: "https://2gis.kz/almaty/firm/123" },
    ];
    const e = enrichBoutique(base({ biography: "shop", externalUrls }));
    expect(e.whatsapp).toEqual(["https://wa.me/77015550000"]);
    expect(e.telegram).toEqual(["@mychannel"]);
    expect(e.googleMaps).toEqual(["https://maps.app.goo.gl/abc"]);
    expect(e.twoGis).toEqual(["https://2gis.kz/almaty/firm/123"]);
    expect(e.website).toBe("https://example.kz/");
  });

  it("reads WhatsApp and Telegram written inline in the bio", () => {
    const e = enrichBoutique(
      base({ biography: "WhatsApp: 87011234567\nTelegram: @shopastana\nМы в Астане" }),
    );
    expect(e.whatsapp).toContain("https://wa.me/77011234567");
    expect(e.telegram).toContain("@shopastana");
    expect(e.city).toBe("Астана"); // inflected "Астане" still resolves
  });

  it("prefers the structured business address for city and street", () => {
    const e = enrichBoutique(
      base({
        biography: "Best boutique",
        businessAddress: {
          cityName: "Almaty, Kazakhstan",
          streetAddress: "Abay 89",
          zipCode: "050000",
          latitude: 43.2,
          longitude: 76.9,
        },
      }),
    );
    expect(e.city).toBe("Almaty");
    expect(e.address).toBe("Abay 89, 050000");
  });

  it("does not treat Instagram/social links as the website", () => {
    const e = enrichBoutique(
      base({
        externalUrls: [
          { title: null, url: "https://instagram.com/foo" },
          { title: null, url: "https://tiktok.com/@foo" },
        ],
      }),
    );
    expect(e.website).toBeNull();
  });

  it("does not misread hours or years as phone numbers", () => {
    const e = enrichBoutique(base({ biography: "Работаем с 2016 года, 10:00-22:00" }));
    expect(e.phones).toEqual([]);
    expect(e.businessHours).toBe("10:00–22:00");
  });
});
