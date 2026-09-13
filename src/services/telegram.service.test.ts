import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, update, count } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { boutique: { findFirst, update, count } },
}));

import {
  buildCaption,
  processNextTelegramPost,
  type PublishableBoutique,
  toHashtag,
} from "./telegram.service";

const boutique = (over: Partial<PublishableBoutique> = {}): PublishableBoutique => ({
  id: "b1",
  name: "Bebetto",
  city: "Алматы",
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

/** A minimal READY_TO_PUBLISH boutique row for the publisher. */
function readyRow(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    name: "Test",
    city: "Алматы",
    posts: [],
    productCategories: [],
    followersCount: null,
    bio: null,
    instagramUrl: null,
    externalUrl: null,
    avatarUrl: null,
    ...over,
  };
}

describe("processNextTelegramPost — decoupled from approval", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    count.mockReset();
    count.mockResolvedValue(0);
    update.mockResolvedValue(readyRow());
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it("selects APPROVED boutiques whose Telegram state is still PENDING", async () => {
    findFirst.mockResolvedValue(null);
    await processNextTelegramPost();
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: "APPROVED", telegramStatus: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("skips a non-Almaty boutique: marks telegramStatus SKIPPED, never calls Telegram, keeps it APPROVED", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    findFirst.mockResolvedValue(readyRow({ city: "Астана" }));

    const result = await processNextTelegramPost();

    expect(update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { telegramStatus: "SKIPPED", telegramError: null },
    });
    // Approval status is never touched by the publisher.
    const updateData = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateData.data).not.toHaveProperty("status");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("SKIPPED");
    expect(result.processed).toBe(true);
  });

  it("publishes an Almaty boutique: marks telegramStatus PUBLISHED without changing approval", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHANNEL_ID = "@chan";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    findFirst.mockResolvedValue(readyRow({ city: "Алматы", avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).toHaveBeenCalledTimes(1); // actually published
    expect(update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { telegramStatus: "PUBLISHED", telegramError: null },
    });
    const updateData = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateData.data).not.toHaveProperty("status");
    expect(result.status).toBe("PUBLISHED");
  });
});
