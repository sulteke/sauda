import { describe, expect, it } from "vitest";

import { buildCaption, type PublishableBoutique, toHashtag } from "./telegram.service";

const boutique = (over: Partial<PublishableBoutique> = {}): PublishableBoutique => ({
  name: "Bebetto",
  categories: [],
  followersCount: null,
  bio: null,
  instagramUrl: "https://www.instagram.com/bebetto_almaty_official/",
  externalUrl: null,
  avatarUrl: null,
  posts: [],
  ...over,
});

describe("toHashtag", () => {
  it("prefixes with # and preserves Cyrillic", () => {
    expect(toHashtag("Худи")).toBe("#Худи");
    expect(toHashtag("Футболки")).toBe("#Футболки");
    expect(toHashtag("Джинсы")).toBe("#Джинсы");
    expect(toHashtag("Классика")).toBe("#Классика");
  });

  it("removes spaces and title-cases each word", () => {
    expect(toHashtag("Головной убор")).toBe("#ГоловнойУбор");
    expect(toHashtag("Детская одежда")).toBe("#ДетскаяОдежда");
  });

  it("removes punctuation", () => {
    expect(toHashtag("Обувь / Кроссовки")).toBe("#ОбувьКроссовки");
    expect(toHashtag("Аксессуары!")).toBe("#Аксессуары");
  });

  it("keeps Latin labels intact", () => {
    expect(toHashtag("School")).toBe("#School");
  });

  it("returns empty string for a label with no letters or digits", () => {
    expect(toHashtag("—")).toBe("");
    expect(toHashtag("")).toBe("");
  });
});

describe("buildCaption — Instagram link", () => {
  it("shows 'Instagram' as the link text, not the raw URL", () => {
    const caption = buildCaption(boutique());
    expect(caption).toContain(
      '📷 <a href="https://www.instagram.com/bebetto_almaty_official/">Instagram</a>',
    );
    // The raw URL never appears as bare visible text (only inside the href).
    expect(caption).not.toContain("📷 https://");
  });

  it("omits the Instagram line entirely when there is no URL", () => {
    const caption = buildCaption(boutique({ instagramUrl: null }));
    expect(caption).not.toContain("📷");
    expect(caption).not.toContain("Instagram");
  });
});
