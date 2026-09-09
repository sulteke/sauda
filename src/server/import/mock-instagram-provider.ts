import "server-only";

import { MAX_RECENT_POSTS } from "./provider-types";
import type {
  InstagramProfileRequest,
  InstagramProvider,
  RawInstagramProfile,
} from "./provider-types";

function hashToInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function prettifyHandle(handle: string): string {
  return handle
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Deterministic, offline stand-in for a real Instagram provider. It fabricates a
 * profile from the handle so the whole pipeline can be exercised end-to-end
 * before any scraping exists. Replace via getInstagramProvider() — nothing
 * downstream changes.
 */
export class MockInstagramProvider implements InstagramProvider {
  readonly name = "mock";

  async fetchProfile({ url, handle }: InstagramProfileRequest): Promise<RawInstagramProfile> {
    const seed = hashToInt(handle);
    const externalUrl = `https://${handle.replace(/[^a-z0-9]/gi, "")}.example`;
    const recentPosts = Array.from({ length: MAX_RECENT_POSTS }, (_, i) => ({
      imageUrl: `https://picsum.photos/seed/${handle}-${i}/500/500`,
      caption: `Auto-discovered post ${i + 1} from @${handle}`,
      likes: 40 + ((seed + i * 7) % 1200),
      comments: (seed + i * 3) % 90,
      permalink: `https://www.instagram.com/${handle}/`,
      type: i % 3 === 0 ? "Video" : "Image",
      videoUrl: null,
      hashtags: ["almaty", "boutique"],
      mentions: [],
      taggedUsers: [],
      locationName: i === 0 ? "Almaty" : null,
      locationId: null,
      childPosts: [],
      musicInfo: null,
      dimensions: { width: 500, height: 500 },
      isPinned: i === 0,
    }));

    return {
      handle,
      fullName: prettifyHandle(handle) || handle,
      biography: `Almaty boutique · auto-discovered from @${handle}. (mock provider — replace with a real Instagram source)`,
      profilePicUrl: `https://picsum.photos/seed/${handle}-avatar/240/240`,
      externalUrl,
      followersCount: 500 + (seed % 25000),
      isVerified: seed % 5 === 0,
      recentPosts,
      postsCount: 12 + (seed % 400),
      followsCount: 100 + (seed % 900),
      isBusinessAccount: true,
      isPrivate: false,
      businessAddress: null,
      externalUrls: [{ title: null, url: externalUrl }],
      relatedProfiles: [],
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      raw: { provider: "mock", handle, note: "deterministic mock payload" },
    };
  }
}
