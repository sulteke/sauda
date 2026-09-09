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

/** A post item as returned by the general Instagram Scraper (resultsType posts). */
const postItem = (i: number) => ({
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
});

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

const isProfileUrl = (url: unknown) => String(url).includes("profile-scraper");

/** Routes fetch by actor: profile scraper vs posts scraper. */
function route(handlers: {
  profile: () => Response | Promise<Response>;
  posts?: () => Response | Promise<Response>;
}) {
  fetchMock.mockImplementation(async (url: string) =>
    isProfileUrl(url) ? handlers.profile() : (handlers.posts ?? (() => jsonResponse([])))(),
  );
}

function createProvider() {
  return new ApifyInstagramProvider({
    token: "test-token",
    timeoutMs: 50,
    baseUrl: "https://api.apify.test",
  });
}

const REQUEST = { url: "https://instagram.com/almaty.boutique", handle: "almaty.boutique" };

let fetchMock: ReturnType<typeof vi.fn>;

describe("ApifyInstagramProvider", () => {
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

  it("maps profile fields from the profile scraper and posts from the posts actor", async () => {
    route({ profile: () => jsonResponse([SAMPLE_ITEM]), posts: () => jsonResponse([postItem(0)]) });

    const result = await createProvider().fetchProfile(REQUEST);

    // Profile-level data comes from the profile scraper.
    expect(result.handle).toBe("almaty.boutique");
    expect(result.fullName).toBe("Almaty Boutique");
    expect(result.biography).toBe("Best boutique in Almaty");
    expect(result.profilePicUrl).toBe("https://img.example/hd.jpg"); // prefers HD
    expect(result.followersCount).toBe(12345);
    expect(result.isVerified).toBe(true);
    expect(result).not.toHaveProperty("category");
    expect(result.sourceUrl).toBe(REQUEST.url);

    // Posts come from the posts actor.
    expect(result.recentPosts).toHaveLength(1);
    expect(result.recentPosts[0]?.caption).toBe("post 0");

    const raw = result.raw as { provider: string; recentPosts: unknown[]; highlights: unknown[] };
    expect(raw.provider).toBe("apify");
    expect(raw.recentPosts).toHaveLength(1);
    expect(raw.highlights).toHaveLength(1); // highlights still from the profile scraper
    // Two actor calls: profile + posts.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("calls the posts actor with resultsType posts and resultsLimit MAX_RECENT_POSTS", async () => {
    route({ profile: () => jsonResponse([SAMPLE_ITEM]), posts: () => jsonResponse([postItem(0)]) });
    await createProvider().fetchProfile(REQUEST);

    const calls = fetchMock.mock.calls;
    const profileCall = calls.find((c) => isProfileUrl(c[0]))!;
    const postsCall = calls.find((c) => !isProfileUrl(c[0]))!;
    const profileBody = JSON.parse((profileCall[1] as { body: string }).body);
    const postsBody = JSON.parse((postsCall[1] as { body: string }).body);

    expect(String(postsCall[0])).toContain("/acts/apify~instagram-scraper/");
    expect(profileBody.resultsLimit).toBe(MAX_RECENT_POSTS);
    expect(postsBody.resultsType).toBe("posts");
    expect(postsBody.resultsLimit).toBe(MAX_RECENT_POSTS);
    expect(postsBody.directUrls).toEqual(["https://www.instagram.com/almaty.boutique/"]);
    expect(MAX_RECENT_POSTS).toBe(30);
  });

  it("imports up to MAX_RECENT_POSTS posts and preserves their metadata", async () => {
    const many = Array.from({ length: MAX_RECENT_POSTS + 5 }, (_, i) => postItem(i));
    route({ profile: () => jsonResponse([SAMPLE_ITEM]), posts: () => jsonResponse(many) });

    const result = await createProvider().fetchProfile(REQUEST);

    expect(result.recentPosts).toHaveLength(MAX_RECENT_POSTS);
    const post = result.recentPosts[0]!;
    expect(post.type).toBe("Video");
    expect(post.videoUrl).toBe("https://cdn.example/v.mp4");
    expect(post.hashtags).toEqual(["almaty", "sale"]);
    expect(post.mentions).toEqual(["brand"]);
    expect(post.taggedUsers).toEqual(["partner"]);
    expect(post.dimensions).toEqual({ width: 1080, height: 1080 });
  });

  it("falls back to the profile scraper's posts when the posts actor returns nothing", async () => {
    route({ profile: () => jsonResponse([SAMPLE_ITEM]), posts: () => jsonResponse([]) });

    const result = await createProvider().fetchProfile(REQUEST);
    expect(result.recentPosts).toHaveLength(1);
    expect(result.recentPosts[0]?.caption).toBe("hello"); // from SAMPLE_ITEM.latestPosts
  });

  it("does not fail the import when the posts actor errors (falls back to profile posts)", async () => {
    route({
      profile: () => jsonResponse([SAMPLE_ITEM]),
      posts: () => {
        throw new Error("posts actor down");
      },
    });

    const result = await createProvider().fetchProfile(REQUEST);
    expect(result.handle).toBe("almaty.boutique");
    expect(result.recentPosts).toHaveLength(1); // profile-scraper fallback
  });

  it("drops error/placeholder items from the posts actor", async () => {
    route({
      profile: () => jsonResponse([SAMPLE_ITEM]),
      posts: () => jsonResponse([{ error: "restricted" }, { errorDescription: "x" }]),
    });

    const result = await createProvider().fetchProfile(REQUEST);
    expect(result.recentPosts).toHaveLength(1); // no valid actor posts → fallback
  });

  it("normalizes a slash actor id to the tilde form in the request URL", async () => {
    route({ profile: () => jsonResponse([SAMPLE_ITEM]), posts: () => jsonResponse([]) });

    const provider = new ApifyInstagramProvider({
      token: "test-token",
      timeoutMs: 50,
      baseUrl: "https://api.apify.test",
      actorId: "apify/instagram-profile-scraper",
    });
    await provider.fetchProfile(REQUEST);

    const profileUrl = fetchMock.mock.calls.find((c) => isProfileUrl(c[0]))?.[0] as string;
    expect(profileUrl).toContain("/acts/apify~instagram-profile-scraper/");
    expect(profileUrl).not.toContain("apify/instagram-profile-scraper");
  });

  it("retries the profile call once and then succeeds", async () => {
    let profileCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (isProfileUrl(url)) {
        profileCalls += 1;
        if (profileCalls === 1) throw new Error("network glitch");
        return jsonResponse([SAMPLE_ITEM]);
      }
      return jsonResponse([]);
    });

    const result = await createProvider().fetchProfile(REQUEST);
    expect(result.handle).toBe("almaty.boutique");
    expect(profileCalls).toBe(2);
  });

  it("throws a typed error after the profile call fails twice (posts never reached)", async () => {
    let profileCalls = 0;
    let postsCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (isProfileUrl(url)) {
        profileCalls += 1;
        throw new Error("down");
      }
      postsCalls += 1;
      return jsonResponse([]);
    });

    await expect(createProvider().fetchProfile(REQUEST)).rejects.toBeInstanceOf(
      InstagramProviderError,
    );
    expect(profileCalls).toBe(2);
    expect(postsCalls).toBe(0);
  });

  it("throws a typed error on a non-OK profile response", async () => {
    route({ profile: () => jsonResponse({ error: "rate limited" }, false, 429) });

    await expect(createProvider().fetchProfile(REQUEST)).rejects.toBeInstanceOf(
      InstagramProviderError,
    );
  });

  it("surfaces a timeout as a typed error", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockImplementation(async (url: string) => {
      if (isProfileUrl(url)) throw abort;
      return jsonResponse([]);
    });

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
    route({ profile: () => jsonResponse([]) });

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
