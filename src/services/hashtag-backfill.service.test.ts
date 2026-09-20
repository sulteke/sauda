import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, update } = vi.hoisted(() => ({ findMany: vi.fn(), update: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { boutique: { findMany, update } } }));

import { MAX_TELEGRAM_HASHTAGS, TELEGRAM_HASHTAG_LIST } from "@/config/telegram-hashtags";

import { backfillBoutiqueHashtags } from "./hashtag-backfill.service";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    name: "Test",
    bio: null,
    description: null,
    productCategories: [],
    posts: [],
    ...over,
  };
}

const dataOf = (i = 0) => (update.mock.calls[i]?.[0] as { data: { hashtags: string[] } }).data;

beforeEach(() => {
  findMany.mockReset();
  update.mockReset();
  update.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("backfillBoutiqueHashtags", () => {
  it("selects only boutiques that have no hashtags yet", async () => {
    findMany.mockResolvedValue([]);
    await backfillBoutiqueHashtags();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hashtags: { isEmpty: true } } }),
    );
  });

  it("fills an old boutique from its stored category + description, with NO model call", async () => {
    findMany.mockResolvedValue([
      row({ productCategories: ["zhakety"], bio: "Женская одежда, деловой стиль" }),
    ]);

    const result = await backfillBoutiqueHashtags();

    const { hashtags } = dataOf();
    expect(hashtags[0]).toBe("#Жакеты");
    expect(hashtags).toContain("#Женскаяодежда");
    expect(hashtags.every((t) => TELEGRAM_HASHTAG_LIST.includes(t))).toBe(true);
    expect(result).toMatchObject({ candidates: 1, updated: 1, skipped: 0 });
  });

  it("uses post captions as evidence too", async () => {
    findMany.mockResolvedValue([
      row({ posts: [{ caption: "Новые кроссовки в наличии" }, { caption: null }] }),
    ]);

    await backfillBoutiqueHashtags();

    expect(dataOf().hashtags).toContain("#Кроссовки");
  });

  it("never writes more than five hashtags", async () => {
    findMany.mockResolvedValue([
      row({
        productCategories: ["obuv", "dzhinsy", "hudi", "futbolki", "sumki", "ochki"],
        bio: "женская мужская детская одежда кроссовки туфли часы очки сумки",
      }),
    ]);

    await backfillBoutiqueHashtags();

    const { hashtags } = dataOf();
    expect(hashtags.length).toBeLessThanOrEqual(MAX_TELEGRAM_HASHTAGS);
    expect(new Set(hashtags).size).toBe(hashtags.length);
  });

  it("leaves a boutique untouched when the stored data supports no tag", async () => {
    findMany.mockResolvedValue([row({ name: "Shop", bio: "нет улик" })]);

    const result = await backfillBoutiqueHashtags();

    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidates: 1, updated: 0, skipped: 1 });
  });

  it("writes ONLY the hashtags column — categories and AI results are untouched", async () => {
    findMany.mockResolvedValue([row({ productCategories: ["hudi"] })]);

    await backfillBoutiqueHashtags();

    expect(Object.keys(dataOf())).toEqual(["hashtags"]);
  });

  it("dryRun reports what would change without writing", async () => {
    findMany.mockResolvedValue([row({ productCategories: ["hudi"] })]);

    const result = await backfillBoutiqueHashtags({ dryRun: true });

    expect(update).not.toHaveBeenCalled();
    expect(result.updated).toBe(1);
    expect(result.details[0]?.hashtags).toContain("#Худи");
  });

  it("is idempotent — a second pass finds nothing left to do", async () => {
    findMany.mockResolvedValueOnce([row({ productCategories: ["hudi"] })]).mockResolvedValueOnce([]);

    await backfillBoutiqueHashtags();
    const second = await backfillBoutiqueHashtags();

    expect(second).toMatchObject({ candidates: 0, updated: 0 });
  });
});
