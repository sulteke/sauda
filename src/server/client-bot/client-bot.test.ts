import { describe, expect, it } from "vitest";

import {
  buildCard,
  buildMenu,
  hashtagKey,
  isValidWebhookSecret,
  parseCallback,
} from "./client-bot";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("hashtagKey", () => {
  it("is 12 hex characters and stable", () => {
    expect(hashtagKey("#Обувь")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashtagKey("#Обувь")).toBe(hashtagKey("#Обувь"));
  });
});

describe("parseCallback", () => {
  it("reads the three callbacks the bot creates", () => {
    const key = hashtagKey("#Обувь");
    expect(parseCallback("menu")).toEqual({ action: "menu" });
    expect(parseCallback(`cat:${key}`)).toEqual({ action: "category", key });
    expect(parseCallback(`next:${key}:${UUID}`)).toEqual({ action: "next", key, afterId: UUID });
  });

  it("rejects anything else", () => {
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback("cat:not-a-key")).toBeNull();
    expect(parseCallback("cat:0123456789ab:extra")).toBeNull();
    expect(parseCallback("delete:everything")).toBeNull();
  });
});

describe("callback data", () => {
  it("fits Telegram's 64-byte limit for a full boutique id", () => {
    const data = `next:${hashtagKey("#Обувь")}:${UUID}`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });
});

describe("buildMenu", () => {
  it("makes one button per hashtag, two per row, with the count", () => {
    const menu = buildMenu([
      { hashtag: "#Обувь", count: 3 },
      { hashtag: "#Кеды", count: 2 },
      { hashtag: "#Сумки", count: 1 },
    ]);
    const rows = menu.reply_markup!.inline_keyboard;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      { text: "#Обувь (3)", callback_data: `cat:${hashtagKey("#Обувь")}` },
      { text: "#Кеды (2)", callback_data: `cat:${hashtagKey("#Кеды")}` },
    ]);
  });

  it("says so, without a keyboard, when nothing is available", () => {
    const menu = buildMenu([]);
    expect(menu.reply_markup).toBeUndefined();
    expect(menu.text).toContain("Әзірге");
  });
});

describe("buildCard", () => {
  const boutique = {
    id: UUID,
    name: "<Alpha> & Co",
    city: "Алматы",
    hashtags: ["#Обувь"],
    instagramUrl: "https://www.instagram.com/alpha",
  };

  it("escapes HTML in the name and shows the city and hashtags", () => {
    const card = buildCard(boutique, "#Обувь", false);
    expect(card.caption).toContain("<b>&lt;Alpha&gt; &amp; Co</b>");
    expect(card.caption).toContain("📍 Алматы");
    expect(card.caption).toContain("#Обувь");
  });

  it("offers 'next' only when there is one, and always offers the way back", () => {
    const withNext = buildCard(boutique, "#Обувь", true).reply_markup.inline_keyboard.flat();
    const last = buildCard(boutique, "#Обувь", false).reply_markup.inline_keyboard.flat();
    expect(withNext).toContainEqual({
      text: "Келесі бутик ▶",
      callback_data: `next:${hashtagKey("#Обувь")}:${UUID}`,
    });
    expect(last.some((b) => "callback_data" in b && b.callback_data.startsWith("next:"))).toBe(
      false,
    );
    expect(last).toContainEqual({ text: "◀ Басқа санат", callback_data: "menu" });
  });

  it("links to Instagram only over https", () => {
    const card = buildCard({ ...boutique, instagramUrl: "javascript:alert(1)" }, "#Обувь", false);
    expect(JSON.stringify(card.reply_markup)).not.toContain("javascript:");
  });
});

describe("isValidWebhookSecret", () => {
  it("accepts only the exact secret", () => {
    expect(isValidWebhookSecret("s3cret", "s3cret")).toBe(true);
    expect(isValidWebhookSecret("s3cre", "s3cret")).toBe(false);
    expect(isValidWebhookSecret(null, "s3cret")).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    expect(isValidWebhookSecret("", undefined)).toBe(false);
    expect(isValidWebhookSecret("anything", undefined)).toBe(false);
  });
});
