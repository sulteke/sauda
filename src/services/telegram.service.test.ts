import { describe, expect, it } from "vitest";

import { toHashtag } from "./telegram.service";

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
