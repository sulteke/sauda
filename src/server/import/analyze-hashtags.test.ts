import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_ANALYSIS_LIMIT,
  DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT,
  DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS,
  dailyAnalysisLimit,
  dailyTelegramPublishLimit,
} from "@/config/limits";
import {
  MAX_TELEGRAM_HASHTAGS,
  sanitizeHashtags,
  TELEGRAM_HASHTAG_LIST,
} from "@/config/telegram-hashtags";
import { EMPTY_AI_RESULT } from "@/lib/ai-category-provider";
import type { HybridDetectionResult } from "@/lib/category-pipeline";
import { MIN_TELEGRAM_HASHTAGS } from "@/lib/hashtag-derivation";

import { mapProfileToPreview } from "./import-pipeline";
import type { RawInstagramProfile } from "./provider-types";

function profile(over: Partial<RawInstagramProfile> = {}): RawInstagramProfile {
  return {
    handle: "qoima",
    fullName: "Qoima",
    biography: "Женская одежда: платья и юбки. Классика и деловой стиль.",
    profilePicUrl: null,
    externalUrl: null,
    followersCount: 9000,
    isVerified: false,
    recentPosts: [],
    postsCount: 3,
    followsCount: 1,
    isBusinessAccount: true,
    isPrivate: false,
    businessAddress: null,
    externalUrls: [],
    relatedProfiles: [],
    sourceUrl: "https://instagram.com/qoima",
    fetchedAt: new Date().toISOString(),
    raw: {},
    ...over,
  };
}

function detection(over: Partial<HybridDetectionResult> = {}): HybridDetectionResult {
  return {
    keyword: [],
    ai: { ...EMPTY_AI_RESULT },
    autoDetected: [],
    ...over,
  } as HybridDetectionResult;
}

const enrichment = { city: null } as never;

describe("a new analyze produces 2–5 whitelist hashtags", () => {
  it("keeps the AI's picks when it returned enough", () => {
    const preview = mapProfileToPreview(
      profile(),
      detection({ ai: { ...EMPTY_AI_RESULT, hashtags: ["#Женскаяодежда", "#Платья", "#Юбки"] } }),
      enrichment,
      true,
    );
    expect(preview.hashtags).toEqual(["#Женскаяодежда", "#Платья", "#Юбки"]);
  });

  it("tops a thin AI reply up to the target from categories + profile text", () => {
    const preview = mapProfileToPreview(
      profile(),
      detection({
        ai: { ...EMPTY_AI_RESULT, hashtags: ["#Платья"] },
        autoDetected: [{ id: "klassika", label: "Классика", score: 9, matches: [] }],
      }),
      enrichment,
      true,
    );
    expect(preview.hashtags![0]).toBe("#Платья");
    expect(preview.hashtags!.length).toBeGreaterThanOrEqual(MIN_TELEGRAM_HASHTAGS);
    expect(preview.hashtags!.every((t) => TELEGRAM_HASHTAG_LIST.includes(t))).toBe(true);
  });

  it("removes invented tags and duplicates, and caps at five", () => {
    const preview = mapProfileToPreview(
      profile(),
      detection({
        ai: {
          ...EMPTY_AI_RESULT,
          hashtags: ["#Платья", "платья", "#ВыдуманныйТег", "#Юбки", "#Топы", "#Блузки", "#Классика"],
        },
      }),
      enrichment,
      true,
    );
    const tags = preview.hashtags!;
    expect(tags).not.toContain("#ВыдуманныйТег");
    expect(tags.filter((t) => t === "#Платья")).toHaveLength(1);
    expect(tags).toHaveLength(MAX_TELEGRAM_HASHTAGS);
  });

  it("still yields hashtags on a keyword-only parse, where no AI ran", () => {
    const preview = mapProfileToPreview(
      profile(),
      detection({ autoDetected: [{ id: "zhakety", label: "Жакеты", score: 7, matches: [] }] }),
      enrichment,
      false,
    );
    expect(preview.aiResult).toBeUndefined(); // no AI record written
    expect(preview.hashtags![0]).toBe("#Жакеты");
    expect(preview.hashtags!.length).toBeGreaterThanOrEqual(MIN_TELEGRAM_HASHTAGS);
  });

  it("records the AI's own answer unchanged, separately from the published set", () => {
    const ai = { ...EMPTY_AI_RESULT, hashtags: ["#Платья"] };
    const preview = mapProfileToPreview(profile(), detection({ ai }), enrichment, true);
    // The published set was topped up; the AI record still says exactly what it said.
    expect(preview.aiResult!.hashtags).toEqual(["#Платья"]);
    expect(preview.hashtags!.length).toBeGreaterThan(1);
  });

  it("leaves the category fields alone — hashtags are a separate axis", () => {
    const autoDetected = [{ id: "zhakety", label: "Жакеты", score: 7, matches: [] }];
    const preview = mapProfileToPreview(profile(), detection({ autoDetected }), enrichment, true);
    expect(preview.productCategories).toEqual([{ id: "zhakety", label: "Жакеты" }]);
    expect(preview.category).toBe("Жакеты");
  });
});

describe("the hashtag work did not change any existing limit", () => {
  it("keeps the daily AI limit at 20", () => {
    expect(DEFAULT_DAILY_ANALYSIS_LIMIT).toBe(20);
    expect(dailyAnalysisLimit()).toBe(20);
  });

  it("keeps the daily Telegram publication limit at 20", () => {
    expect(DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT).toBe(20);
    expect(dailyTelegramPublishLimit()).toBe(20);
  });

  it("keeps the follower gate at 5,000", () => {
    expect(DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS).toBe(5_000);
  });

  it("introduces no separate hashtag quota — the whitelist is just data", () => {
    // The whitelist is free to grow with the taxonomy; what must NOT move is
    // how many tags reach a post. Offering the model every valid tag still
    // yields at most MAX_TELEGRAM_HASHTAGS, so a bigger vocabulary can never
    // turn into a bigger post — or into a second limit of its own.
    expect(TELEGRAM_HASHTAG_LIST.length).toBeGreaterThan(MAX_TELEGRAM_HASHTAGS);
    expect(sanitizeHashtags([...TELEGRAM_HASHTAG_LIST])).toHaveLength(MAX_TELEGRAM_HASHTAGS);
  });
});
