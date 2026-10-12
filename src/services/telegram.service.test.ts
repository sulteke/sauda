import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT } from "@/config/limits";

const { findFirst, findUnique, update, count } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { boutique: { findFirst, findUnique, update, count } },
}));

const { parseInstagramProfile } = vi.hoisted(() => ({ parseInstagramProfile: vi.fn() }));
vi.mock("@/services/import.service", () => ({ parseInstagramProfile }));

import {
  buildCaption,
  processNextTelegramPost,
  publishWithOverride,
  type PublishableBoutique,
  refreshPublicationImages,
  retryFailedPublication,
  toHashtag,
} from "./telegram.service";

/** Instagram CDN links, signed to expire well in the past or well in the future. */
const DAY = 24 * 3600 * 1000;
const igLink = (offsetMs: number, name: string) =>
  `https://scontent.cdninstagram.com/v/${name}.jpg?oe=${Math.floor(
    (Date.now() + offsetMs) / 1000,
  ).toString(16)}`;
const deadImages = {
  avatarUrl: igLink(-3 * DAY, "a"),
  posts: [{ imageUrl: igLink(-3 * DAY, "p1"), caption: null }],
};
const liveImages = {
  avatarUrl: igLink(4 * DAY, "a"),
  posts: [{ imageUrl: igLink(4 * DAY, "p1"), caption: null }],
};

const boutique = (over: Partial<PublishableBoutique> = {}): PublishableBoutique => ({
  id: "b1",
  name: "Bebetto",
  city: "Алматы",
  overrideCity: null,
  categories: [],
  hashtags: [],
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

describe("buildCaption — hashtags", () => {
  it("renders the AI's whitelisted hashtags verbatim", () => {
    const caption = buildCaption(
      boutique({ hashtags: ["#Женскаяодежда", "#Платья", "#Классика"] }),
    );
    expect(caption).toContain("🏷 Категориялар\n#Женскаяодежда #Платья #Классика");
  });

  it("prefers the AI hashtags over the category labels when both exist", () => {
    const caption = buildCaption(
      boutique({ hashtags: ["#Кроссовки"], categories: ["Джинсы", "Футболки"] }),
    );
    expect(caption).toContain("#Кроссовки");
    expect(caption).not.toContain("#Джинсы");
  });

  it("falls back to category labels for boutiques analyzed before hashtags existed", () => {
    const caption = buildCaption(boutique({ hashtags: [], categories: ["Худи", "Джинсы"] }));
    expect(caption).toContain("🏷 Категориялар\n#Худи #Джинсы");
  });

  it("never renders more than five hashtags", () => {
    const caption = buildCaption(
      boutique({
        hashtags: ["#Худи", "#Футболки", "#Джинсы", "#Обувь", "#Кроссовки", "#Кеды", "#Топы"],
      }),
    );
    const line = caption.split("🏷 Категориялар\n")[1] ?? "";
    expect(line.trim().split(" ")).toHaveLength(5);
  });

  it("omits the section entirely when there is nothing to show", () => {
    expect(buildCaption(boutique({ hashtags: [], categories: [] }))).not.toContain("🏷");
  });
});

/** A minimal APPROVED boutique row for the publisher. */
function readyRow(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    name: "Test",
    status: "APPROVED",
    city: "Алматы",
    telegramOverrideCity: null,
    aiResult: null,
    hashtags: [],
    description: null,
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

/** Telegram configured + a Bot API that always succeeds. Returns the fetch mock. */
function stubTelegramOk() {
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_CHANNEL_ID = "@chan";
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Makes today's publication count report `published`, leaving other counts at 0. */
function stubPublishedToday(published: number) {
  count.mockImplementation((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(args?.where?.telegramPublishedAt ? published : 0),
  );
}

/** The `data` of the Nth prisma update call. */
function updateData(index = 0): Record<string, unknown> {
  return (update.mock.calls[index]?.[0] as { data: Record<string, unknown> }).data;
}

describe("processNextTelegramPost — decoupled from approval", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset();
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

    const updateData = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(updateData).toMatchObject({ telegramStatus: "SKIPPED", telegramError: null });
    // Approval status is never touched by the publisher; no failure detail on skip.
    expect(updateData).not.toHaveProperty("status");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("SKIPPED");
    expect(result.processed).toBe(true);
  });

  it("publishes an Almaty boutique: marks telegramStatus PUBLISHED without changing approval", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHANNEL_ID = "@chan";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    findFirst.mockResolvedValue(readyRow({ city: "Алматы", avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).toHaveBeenCalledTimes(1); // actually published
    const updateData = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(updateData).toMatchObject({ telegramStatus: "PUBLISHED", telegramError: null });
    expect(updateData).not.toHaveProperty("status");
    expect(result.status).toBe("PUBLISHED");
  });

  it("records the COMPLETE Telegram error + structured detail on failure", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHANNEL_ID = "@chan";
    const apiBody = JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => apiBody,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    findFirst.mockResolvedValue(readyRow({ city: "Алматы", avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(result.status).toBe("FAILED");
    const updateData = (update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(updateData.telegramStatus).toBe("FAILED");
    // Full, untruncated message is stored (includes the Telegram description).
    expect(String(updateData.telegramError)).toContain("Bad Request: chat not found");
    // Structured detail carries the HTTP status, target, complete response, time.
    const detail = updateData.telegramFailure as Record<string, unknown>;
    expect(detail.httpStatus).toBe(400);
    expect(detail.targetId).toBe("telegram:almaty");
    expect(String(detail.response)).toContain("error_code");
    expect(typeof detail.failedAt).toBe("string");
    expect(updateData).not.toHaveProperty("status");
  });
});

describe("hashtags reaching the Telegram caption", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset();
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

  /** Publishes one boutique and returns the caption Telegram received. */
  async function captionFor(over: Record<string, unknown>): Promise<string> {
    const fetchMock = stubTelegramOk();
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg", ...over }));
    await processNextTelegramPost();
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    return String(body.caption ?? body.media?.[0]?.caption ?? "");
  }

  it("publishes the boutique's stored hashtags", async () => {
    const caption = await captionFor({ hashtags: ["#Женскаяодежда", "#Платья", "#Классика"] });
    expect(caption).toContain("🏷 Категориялар\n#Женскаяодежда #Платья #Классика");
  });

  it("drops a stale non-whitelist tag that somehow reached the column", async () => {
    const caption = await captionFor({ hashtags: ["#Худи", "#ВыдуманныйТег"] });
    expect(caption).toContain("#Худи");
    expect(caption).not.toContain("#ВыдуманныйТег");
  });

  it("derives hashtags for an OLD boutique that has none, without any model call", async () => {
    const caption = await captionFor({
      hashtags: [],
      aiResult: null,
      productCategories: ["zhakety"],
      bio: "Женская одежда, деловой стиль",
    });
    expect(caption).toContain("#Жакеты");
    expect(caption).toContain("#Женскаяодежда");
  });

  it("falls back to what the AI recorded when the column is still empty", async () => {
    const caption = await captionFor({
      hashtags: [],
      aiResult: { hashtags: ["#Кроссовки", "#Обувь"] },
      productCategories: [],
    });
    expect(caption).toContain("#Кроссовки");
    expect(caption).toContain("#Обувь");
  });

  it("never renders more than five", async () => {
    const caption = await captionFor({
      hashtags: ["#Худи", "#Футболки", "#Джинсы", "#Обувь", "#Кроссовки", "#Кеды", "#Топы"],
    });
    const line = caption.split("🏷 Категориялар\n")[1]?.split("\n")[0] ?? "";
    expect(line.trim().split(" ")).toHaveLength(5);
  });
});

describe("daily Telegram publication limit", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset();
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

  it("counts a successful publication by stamping telegramPublishedAt", async () => {
    stubTelegramOk();
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    await processNextTelegramPost();

    expect(updateData().telegramPublishedAt).toBeInstanceOf(Date);
  });

  it("counts ONLY successful publications — never a skip", async () => {
    vi.stubGlobal("fetch", vi.fn());
    findFirst.mockResolvedValue(readyRow({ city: "Астана" }));

    await processNextTelegramPost();

    expect(updateData().telegramStatus).toBe("SKIPPED");
    expect(updateData()).not.toHaveProperty("telegramPublishedAt");
  });

  it("counts ONLY successful publications — never a failure", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHANNEL_ID = "@chan";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ ok: false, description: "nope" }),
      } as unknown as Response),
    );
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    await processNextTelegramPost();

    expect(updateData().telegramStatus).toBe("FAILED");
    expect(updateData()).not.toHaveProperty("telegramPublishedAt");
  });

  it("only ever counts rows that were actually published", async () => {
    stubTelegramOk();
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    await processNextTelegramPost();

    // Pending / approved-but-unpublished rows have a null stamp, so a `gte`
    // filter on it cannot include them.
    expect(count).toHaveBeenCalledWith({
      where: { telegramPublishedAt: { gte: expect.any(Date) } },
    });
  });

  it("allows the LAST publication of the day", async () => {
    // Written against the constant, not the number: the ceiling is an editorial
    // choice that moves, and this test is about the boundary, not its value.
    const fetchMock = stubTelegramOk();
    stubPublishedToday(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT - 1);
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("PUBLISHED");
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("blocks the one PAST the limit and leaves the boutique PENDING for the next day", async () => {
    const fetchMock = stubTelegramOk();
    stubPublishedToday(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT);
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // still APPROVED + PENDING
    expect(result).toMatchObject({
      processed: false,
      dailyLimitReached: true,
      publishedToday: DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT,
    });
  });

  it("still resolves an ineligible boutique at the limit — a skip publishes nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubPublishedToday(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT);
    findFirst.mockResolvedValue(readyRow({ city: "Астана" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("SKIPPED");
    expect(result.dailyLimitReached).toBeUndefined();
  });
});

describe("publishWithOverride — manual Unknown-location override", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset();
    update.mockReset();
    count.mockReset();
    count.mockResolvedValue(0);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it("publishes an Unknown-location boutique after confirmation", async () => {
    const fetchMock = stubTelegramOk();
    const row = readyRow({ city: null, avatarUrl: "https://img/a.jpg" });
    findUnique.mockResolvedValue(row);
    update.mockResolvedValue({ ...row, telegramOverrideCity: "Алматы" });

    const result = await publishWithOverride("b1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, status: "PUBLISHED", rejection: null });
    expect(updateData(1).telegramStatus).toBe("PUBLISHED");
    expect(updateData(1).telegramPublishedAt).toBeInstanceOf(Date);
  });

  it("records the confirmation in telegramOverrideCity and NEVER edits the detected city", async () => {
    stubTelegramOk();
    const row = readyRow({ city: null, avatarUrl: "https://img/a.jpg" });
    findUnique.mockResolvedValue(row);
    update.mockResolvedValue({ ...row, telegramOverrideCity: "Алматы" });

    await publishWithOverride("b1");

    expect(updateData(0)).toEqual({ telegramOverrideCity: "Алматы" });
    // The detected city is untouched by every write this path makes.
    for (const call of update.mock.calls) {
      expect((call[0] as { data: Record<string, unknown> }).data).not.toHaveProperty("city");
    }
  });

  it("cannot bypass the daily publication limit", async () => {
    const fetchMock = stubTelegramOk();
    stubPublishedToday(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT);
    findUnique.mockResolvedValue(readyRow({ city: null, avatarUrl: "https://img/a.jpg" }));

    const result = await publishWithOverride("b1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // no override recorded either
    expect(result).toMatchObject({
      ok: false,
      rejection: "DAILY_LIMIT_REACHED",
      publishedToday: DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT,
    });
  });

  it("refuses a boutique whose city WAS detected — that is a detection fix, not an override", async () => {
    const fetchMock = stubTelegramOk();
    findUnique.mockResolvedValue(readyRow({ city: "Астана" }));

    const result = await publishWithOverride("b1");

    expect(result.rejection).toBe("CITY_DETECTED");
    expect(update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a boutique that is not approved", async () => {
    stubTelegramOk();
    findUnique.mockResolvedValue(readyRow({ city: null, status: "NEEDS_REVIEW" }));

    expect((await publishWithOverride("b1")).rejection).toBe("NOT_APPROVED");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a missing boutique", async () => {
    findUnique.mockResolvedValue(null);
    expect((await publishWithOverride("nope")).rejection).toBe("NOT_FOUND");
  });

  it("reports a Telegram failure without claiming success", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHANNEL_ID = "@chan";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ ok: false, description: "chat not found" }),
      } as unknown as Response),
    );
    const row = readyRow({ city: null, avatarUrl: "https://img/a.jpg" });
    findUnique.mockResolvedValue(row);
    update.mockResolvedValue({ ...row, telegramOverrideCity: "Алматы" });

    const result = await publishWithOverride("b1");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAILED");
    expect(String(result.error)).toContain("chat not found");
  });
});

describe("retryFailedPublication — a failed post is not final", () => {
  beforeEach(() => {
    findFirst.mockReset();
    findUnique.mockReset();
    update.mockReset();
    count.mockReset();
    count.mockResolvedValue(0);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * REGRESSION — nothing in the app moved a boutique out of FAILED, so an
   * outage, a missing bot token or a transient Telegram error stranded it
   * there permanently and the only way back was an UPDATE against the
   * database by hand.
   */
  it("moves a FAILED boutique back to PENDING and clears the failure", async () => {
    findUnique.mockResolvedValue(
      readyRow({ telegramStatus: "FAILED", telegramError: "Telegram is not configured." }),
    );
    update.mockResolvedValue(readyRow({ telegramStatus: "PENDING" }));

    const result = await retryFailedPublication("b1");

    expect(result).toEqual({ ok: true, rejection: null });
    expect(updateData(0).telegramStatus).toBe("PENDING");
    expect(updateData(0).telegramError).toBeNull();
  });

  it("sends NOTHING — publishing stays with the queue, where the daily limit lives", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "FAILED" }));
    update.mockResolvedValue(readyRow({ telegramStatus: "PENDING" }));

    await retryFailedPublication("b1");

    expect(fetchMock).not.toHaveBeenCalled();
    // No publication happened, so nothing may claim one.
    expect(updateData(0).telegramPublishedAt).toBeUndefined();
  });

  it("refuses a PUBLISHED boutique — subscribers must not get the same post twice", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "PUBLISHED" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: false, rejection: "NOT_FAILED" });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a boutique skipped for being in ANOTHER city skipped", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "SKIPPED", city: "Астана" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: false, rejection: "NOT_ALMATY" });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a skip whose city is STILL unknown — that is publishWithOverride's call", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "SKIPPED", city: null }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: false, rejection: "NOT_ALMATY" });
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION — Almaty boutiques were skipped while their city was unknown.
   * Once the city was filled in they sat in SKIPPED with no way out: Publish
   * Queue takes only PENDING, "Publish anyway" appears only for an unknown
   * city, and this took only FAILED.
   */
  it("requeues a STALE skip — skipped while the city was unknown, now Almaty", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "SKIPPED", city: "Алматы" }));
    update.mockResolvedValue(readyRow({ telegramStatus: "PENDING" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: true, rejection: null });
    expect(updateData(0).telegramStatus).toBe("PENDING");
  });

  it("does not requeue a skipped boutique that was nonetheless published", async () => {
    // Published by hand through the override, then skipped by a later run:
    // sending it again would post it twice.
    findUnique.mockResolvedValue(
      readyRow({ telegramStatus: "SKIPPED", city: "Алматы", telegramPublishedAt: new Date() }),
    );

    expect(await retryFailedPublication("b1")).toEqual({ ok: false, rejection: "NOT_ALMATY" });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a boutique that is not approved", async () => {
    findUnique.mockResolvedValue(readyRow({ status: "DRAFT", telegramStatus: "FAILED" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: false, rejection: "NOT_APPROVED" });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a missing boutique", async () => {
    findUnique.mockResolvedValue(null);

    expect(await retryFailedPublication("nope")).toEqual({ ok: false, rejection: "NOT_FOUND" });
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION — six boutiques whose image links had all expired were retried
   * into the queue, failed again for the same links, and their failures
   * stopped the run before nine live boutiques behind them were sent.
   */
  it("refuses a boutique whose every image link has expired — it would fail the same way", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "FAILED", ...deadImages }));

    expect(await retryFailedPublication("b1")).toEqual({
      ok: false,
      rejection: "IMAGES_EXPIRED",
    });
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION — the expired-links guard also caught stale skips, and the
   * Skipped column has no Re-parse: such a boutique could not be moved at all.
   * Requeued, it fails into FAILED, where Re-parse is offered.
   */
  it("still requeues a stale SKIP whose links have expired — there is no Re-parse there", async () => {
    findUnique.mockResolvedValue(
      readyRow({ telegramStatus: "SKIPPED", city: "Алматы", ...deadImages }),
    );
    update.mockResolvedValue(readyRow({ telegramStatus: "PENDING" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: true, rejection: null });
    expect(updateData(0).telegramStatus).toBe("PENDING");
  });

  it("requeues a boutique whose images are still live", async () => {
    findUnique.mockResolvedValue(readyRow({ telegramStatus: "FAILED", ...liveImages }));
    update.mockResolvedValue(readyRow({ telegramStatus: "PENDING" }));

    expect(await retryFailedPublication("b1")).toEqual({ ok: true, rejection: null });
  });
});

describe("processNextTelegramPost — expired images", () => {
  const env = { ...process.env };

  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    count.mockReset();
    count.mockResolvedValue(0);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it("fails without calling Telegram, and names the cause so the run keeps going", async () => {
    const fetchMock = stubTelegramOk();
    findFirst.mockResolvedValue(readyRow(deadImages));

    const result = await processNextTelegramPost();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("IMAGES_EXPIRED");
    expect(updateData(0).telegramStatus).toBe("FAILED");
    // Stored with the failure, so the card can offer Re-parse after a reload.
    expect((updateData(0).telegramFailure as { code: string }).code).toBe("IMAGES_EXPIRED");
  });
});

describe("refreshPublicationImages — fresh links for a failed post", () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    parseInstagramProfile.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const failed = (over: Record<string, unknown> = {}) =>
    readyRow({
      telegramStatus: "FAILED",
      instagramUrl: "https://www.instagram.com/shop",
      ...deadImages,
      ...over,
    });

  it("re-parses the profile, then moves the boutique back to PENDING", async () => {
    findUnique.mockResolvedValueOnce(failed()).mockResolvedValueOnce(failed(liveImages));
    parseInstagramProfile.mockResolvedValue({ job: {}, boutiqueId: "b1" });

    expect(await refreshPublicationImages("b1")).toEqual({ ok: true, rejection: null });
    expect(parseInstagramProfile).toHaveBeenCalledWith({ url: "https://www.instagram.com/shop" });
    expect(updateData(0)).toMatchObject({ telegramStatus: "PENDING", telegramError: null });
    // Requeued only: nothing was posted, so nothing may claim a publication.
    expect(updateData(0).telegramPublishedAt).toBeUndefined();
  });

  it("leaves it FAILED when the fresh scrape still has no live image", async () => {
    findUnique.mockResolvedValueOnce(failed()).mockResolvedValueOnce(failed());
    parseInstagramProfile.mockResolvedValue({ job: {}, boutiqueId: "b1" });

    expect(await refreshPublicationImages("b1")).toEqual({
      ok: false,
      rejection: "STILL_EXPIRED",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("stops when the link now leads to a different boutique", async () => {
    findUnique.mockResolvedValueOnce(failed());
    parseInstagramProfile.mockResolvedValue({ job: {}, boutiqueId: "someone-else" });

    expect(await refreshPublicationImages("b1")).toEqual({
      ok: false,
      rejection: "DIFFERENT_PROFILE",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("spends no scrape on a boutique that has not failed", async () => {
    findUnique.mockResolvedValue(failed({ telegramStatus: "PUBLISHED" }));

    expect(await refreshPublicationImages("b1")).toEqual({ ok: false, rejection: "NOT_FAILED" });
    expect(parseInstagramProfile).not.toHaveBeenCalled();
  });

  it("spends no scrape on a boutique without an Instagram link", async () => {
    findUnique.mockResolvedValue(failed({ instagramUrl: null }));

    expect(await refreshPublicationImages("b1")).toEqual({
      ok: false,
      rejection: "NO_INSTAGRAM",
    });
    expect(parseInstagramProfile).not.toHaveBeenCalled();
  });

  it("lets a failed scrape surface as an error", async () => {
    findUnique.mockResolvedValue(failed());
    parseInstagramProfile.mockRejectedValue(new Error("Apify run failed"));

    await expect(refreshPublicationImages("b1")).rejects.toThrow("Apify run failed");
    expect(update).not.toHaveBeenCalled();
  });
});
