import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findUnique, update, count } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { boutique: { findFirst, findUnique, update, count } },
}));

import {
  buildCaption,
  processNextTelegramPost,
  publishWithOverride,
  type PublishableBoutique,
  toHashtag,
} from "./telegram.service";

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

  it("allows the 20th publication of the day", async () => {
    const fetchMock = stubTelegramOk();
    stubPublishedToday(19);
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("PUBLISHED");
    expect(result.dailyLimitReached).toBeUndefined();
  });

  it("blocks the 21st publication and leaves the boutique PENDING for the next day", async () => {
    const fetchMock = stubTelegramOk();
    stubPublishedToday(20);
    findFirst.mockResolvedValue(readyRow({ avatarUrl: "https://img/a.jpg" }));

    const result = await processNextTelegramPost();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // still APPROVED + PENDING
    expect(result).toMatchObject({ processed: false, dailyLimitReached: true, publishedToday: 20 });
  });

  it("still resolves an ineligible boutique at the limit — a skip publishes nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubPublishedToday(20);
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
    stubPublishedToday(20);
    findUnique.mockResolvedValue(readyRow({ city: null, avatarUrl: "https://img/a.jpg" }));

    const result = await publishWithOverride("b1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // no override recorded either
    expect(result).toMatchObject({ ok: false, rejection: "DAILY_LIMIT_REACHED", publishedToday: 20 });
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
