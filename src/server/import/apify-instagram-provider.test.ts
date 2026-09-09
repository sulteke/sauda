import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApifyInstagramProvider } from "./apify-instagram-provider";
import { InstagramProviderError } from "./errors";
import { MAX_RECENT_POSTS } from "./provider-types";

const SAMPLE_ITEM = {
  username: "almaty.boutique",
  fullName: "Almaty Boutique",
  biography: "Best boutique in Almaty",
  followersCount: 12345,
  profilePicUrl: "https://img.example/sd.jpg",
  profilePicUrlHD: "https://img.example/hd.jpg",
  externalUrl: "https://shop.example",
  verified: true,
  businessCategoryName: "Clothing (Brand)",
  latestPosts: [
    {
      id: "1",
      shortCode: "abc",
      caption: "hello",
      likesCount: 10,
      commentsCount: 2,
      timestamp: "2026-01-01T00:00:00Z",
      url: "https://instagram.com/p/abc",
    },
  ],
  highlightReels: [{ id: "h1", title: "New", coverUrl: "https://img.example/cover.jpg" }],
};

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

function createProvider() {
  return new ApifyInstagramProvider({
    token: "test-token",
    timeoutMs: 50,
    baseUrl: "https://api.apify.test",
  });
}

const REQUEST = { url: "https://instagram.com/almaty.boutique", handle: "almaty.boutique" };

describe("ApifyInstagramProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps an Apify profile item into RawInstagramProfile", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));

    const result = await createProvider().fetchProfile(REQUEST);

    expect(result.handle).toBe("almaty.boutique");
    expect(result.fullName).toBe("Almaty Boutique");
    expect(result.biography).toBe("Best boutique in Almaty");
    expect(result.profilePicUrl).toBe("https://img.example/hd.jpg"); // prefers HD
    expect(result.followersCount).toBe(12345);
    expect(result.isVerified).toBe(true);
    // The provider no longer derives a category from businessCategoryName —
    // categorization is done downstream by the detection engine.
    expect(result).not.toHaveProperty("category");
    expect(result.sourceUrl).toBe(REQUEST.url);

    const raw = result.raw as {
      provider: string;
      recentPosts: unknown[];
      highlights: unknown[];
      postsCount: number;
    };
    expect(raw.provider).toBe("apify");
    expect(raw.recentPosts).toHaveLength(1);
    expect(raw.highlights).toHaveLength(1);
    expect(raw.postsCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests the actor's maximum stable post count", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    await createProvider().fetchProfile(REQUEST);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      resultsLimit: number;
    };
    expect(body.resultsLimit).toBe(MAX_RECENT_POSTS);
    expect(MAX_RECENT_POSTS).toBeGreaterThanOrEqual(12);
  });

  it("imports up to MAX_RECENT_POSTS posts and preserves their metadata", async () => {
    const manyPosts = Array.from({ length: MAX_RECENT_POSTS + 5 }, (_, i) => ({
      id: String(i),
      shortCode: `code${i}`,
      caption: `post ${i}`,
      likesCount: i,
      commentsCount: i,
      timestamp: "2026-01-01T00:00:00Z",
      url: `https://instagram.com/p/code${i}`,
      type: "Video",
      videoUrl: "https://cdn.example/v.mp4",
      hashtags: ["almaty", "sale"],
      mentions: ["brand"],
      taggedUsers: [{ username: "partner" }],
      displayUrl: "https://cdn.example/i.jpg",
      dimensionsWidth: 1080,
      dimensionsHeight: 1080,
    }));
    fetchMock.mockResolvedValue(jsonResponse([{ ...SAMPLE_ITEM, latestPosts: manyPosts }]));

    const result = await createProvider().fetchProfile(REQUEST);

    // Capped at the actor's stable ceiling, not the old 6.
    expect(result.recentPosts).toHaveLength(MAX_RECENT_POSTS);
    // All rich metadata is preserved on the imported posts.
    const post = result.recentPosts[0]!;
    expect(post.type).toBe("Video");
    expect(post.videoUrl).toBe("https://cdn.example/v.mp4");
    expect(post.hashtags).toEqual(["almaty", "sale"]);
    expect(post.mentions).toEqual(["brand"]);
    expect(post.taggedUsers).toEqual(["partner"]);
    expect(post.dimensions).toEqual({ width: 1080, height: 1080 });
  });

  it("normalizes a slash actor id to the tilde form in the request URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));

    const provider = new ApifyInstagramProvider({
      token: "test-token",
      timeoutMs: 50,
      baseUrl: "https://api.apify.test",
      actorId: "apify/instagram-profile-scraper",
    });

    await provider.fetchProfile(REQUEST);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/acts/apify~instagram-profile-scraper/");
    expect(calledUrl).not.toContain("apify/instagram-profile-scraper");
  });

  it("retries once and then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network glitch"))
      .mockResolvedValueOnce(jsonResponse([SAMPLE_ITEM]));

    const result = await createProvider().fetchProfile(REQUEST);

    expect(result.handle).toBe("almaty.boutique");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a typed error after failing twice", async () => {
    fetchMock.mockRejectedValue(new Error("down"));

    await expect(createProvider().fetchProfile(REQUEST)).rejects.toBeInstanceOf(
      InstagramProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a typed error on a non-OK response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "rate limited" }, false, 429));

    await expect(createProvider().fetchProfile(REQUEST)).rejects.toBeInstanceOf(
      InstagramProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a timeout as a typed error", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValue(abort);

    const error = await createProvider()
      .fetchProfile(REQUEST)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramProviderError);
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(InstagramProviderError);
    expect(((error as { cause?: Error }).cause as Error).message).toMatch(/timed out/i);
  });

  it("throws (without calling fetch) when APIFY_TOKEN is missing", async () => {
    const provider = new ApifyInstagramProvider({ token: "", timeoutMs: 50 });

    await expect(provider.fetchProfile(REQUEST)).rejects.toBeInstanceOf(InstagramProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the profile is not found", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await expect(createProvider().fetchProfile(REQUEST)).rejects.toBeInstanceOf(
      InstagramProviderError,
    );
  });

  it("parses bio, posts and highlights via the sub-methods", () => {
    const provider = createProvider();

    expect(provider.getBio(SAMPLE_ITEM)).toBe("Best boutique in Almaty");

    const posts = provider.getRecentPosts(SAMPLE_ITEM);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.shortCode).toBe("abc");

    const highlights = provider.getHighlights(SAMPLE_ITEM);
    expect(highlights[0]?.title).toBe("New");
  });
});
