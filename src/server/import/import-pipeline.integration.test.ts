import { describe, expect, it } from "vitest";

import type { AiCategoryProvider } from "@/lib/ai-category-provider";
import { EMPTY_AI_RESULT } from "@/lib/ai-category-provider";
import { enrichBoutique } from "@/lib/boutique-enrichment";
import { runHybridDetection } from "@/lib/category-pipeline";

import { mapProfileToPreview } from "./import-pipeline";
import type { RawInstagramProfile } from "./provider-types";

/** A minimal but valid RawInstagramProfile for assembly tests (no network). */
function fakeProfile(overrides: Partial<RawInstagramProfile> = {}): RawInstagramProfile {
  return {
    handle: "qoima",
    fullName: "Qoima",
    biography: "Магазин: джинсы и худи в Алматы",
    profilePicUrl: "https://img/a.jpg",
    externalUrl: "https://qoima.asia",
    followersCount: 1000,
    isVerified: false,
    recentPosts: [],
    postsCount: 10,
    followsCount: 5,
    isBusinessAccount: true,
    isPrivate: false,
    businessAddress: null,
    externalUrls: [{ title: null, url: "https://qoima.asia" }],
    relatedProfiles: [],
    sourceUrl: "https://instagram.com/qoima",
    fetchedAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

const toInput = (p: RawInstagramProfile) => ({
  biography: p.biography,
  avatarUrl: p.profilePicUrl,
  posts: p.recentPosts.map((post) => ({
    caption: post.caption,
    hashtags: post.hashtags,
    mentions: post.mentions,
    imageUrl: post.imageUrl,
  })),
  businessName: p.fullName,
  username: p.handle,
  externalUrl: p.externalUrl,
  externalUrls: p.externalUrls,
  businessAddress: p.businessAddress,
});

describe("import assembly with AI on (fake provider, no network)", () => {
  it("keeps keyword, raw AI and merged results separate in the preview", async () => {
    const aiProvider: AiCategoryProvider = {
      name: "fake",
      async analyze() {
        return {
          ...EMPTY_AI_RESULT,
          categories: [
            { id: "obuv", confidence: 85, reason: "mentions shoes" }, // valid → merged
            { id: "invented", confidence: 99, reason: "nope" }, // invented → dropped from merge
            { id: "kepki", confidence: 30, reason: "weak" }, // below threshold → dropped
          ],
          city: "Алматы",
          priceSegment: "mid",
          style: "streetwear",
          summary: "Almaty menswear",
        };
      },
    };

    const profile = fakeProfile();
    const enrichment = enrichBoutique({
      biography: profile.biography,
      externalUrl: profile.externalUrl,
      externalUrls: profile.externalUrls,
      businessAddress: profile.businessAddress,
    });
    const detection = await runHybridDetection(toInput(profile), { aiProvider, enrichment });
    const preview = mapProfileToPreview(profile, detection, enrichment, true);

    // Keyword-only result (from the bio) preserved with evidence.
    const keywordIds = preview.keywordScores?.map((c) => c.id) ?? [];
    expect(keywordIds).toEqual(expect.arrayContaining(["dzhinsy", "hudi"]));
    expect(preview.keywordScores?.[0]).toHaveProperty("matches");

    // Raw AI result preserved in full (incl. invented/low-confidence + profiling fields).
    expect(preview.aiResult?.categories).toHaveLength(3);
    expect(preview.aiResult?.city).toBe("Алматы");
    expect(preview.aiResult?.priceSegment).toBe("mid");
    expect(preview.aiResult?.style).toBe("streetwear");

    // Merged auto = keyword + validated AI (obuv in; invented/low-confidence out).
    const mergedIds = preview.categoryScores?.map((c) => c.id) ?? [];
    expect(mergedIds).toEqual(expect.arrayContaining(["dzhinsy", "hudi", "obuv"]));
    expect(mergedIds).not.toContain("invented");
    expect(mergedIds).not.toContain("kepki");

    // Enrichment still flows through (city detected from bio).
    expect(preview.enrichment?.city).toBe("Алматы");
  });

  it("sets aiResult undefined (→ null in DB) when no AI ran", async () => {
    const profile = fakeProfile();
    const enrichment = enrichBoutique({
      biography: profile.biography,
      externalUrl: profile.externalUrl,
      externalUrls: profile.externalUrls,
      businessAddress: profile.businessAddress,
    });
    // disabled-style provider + aiRan=false
    const detection = await runHybridDetection(toInput(profile), { enrichment });
    const preview = mapProfileToPreview(profile, detection, enrichment, false);

    expect(preview.aiResult).toBeUndefined();
    // Keyword still detected and merged.
    expect(preview.keywordScores?.length).toBeGreaterThan(0);
    expect(preview.categoryScores?.map((c) => c.id)).toEqual(
      preview.keywordScores?.map((c) => c.id),
    );
  });
});
