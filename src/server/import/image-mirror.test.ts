import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ImageStore,
  imagePath,
  imageStoreFromEnv,
  MIRRORED_POSTS,
  mirrorImage,
  mirrorProfileImages,
} from "./image-mirror";

/** A store that keeps nothing and answers with a link into "our" storage. */
function fakeStore() {
  const put = vi.fn(
    async (path: string) =>
      `https://proj.supabase.co/storage/v1/object/public/boutique-images/${path}`,
  );
  return { store: { put } as ImageStore, put };
}

const imageResponse = (type = "image/jpeg") =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": type }),
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as Response;

const status = (code: number) =>
  ({
    ok: false,
    status: code,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as unknown as Response;

const IG = (name: string, host = "scontent-iad6-1", query = "oe=69ABCDEF") =>
  `https://${host}.cdninstagram.com/v/t51.2885-19/${name}.jpg?${query}`;

const profile = (posts = 8) => ({
  handle: "Lucente.KZ",
  profilePicUrl: IG("avatar"),
  recentPosts: Array.from({ length: posts }, (_, i) => ({
    imageUrl: IG(`post${i}`),
    caption: `p${i}`,
  })),
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("imagePath", () => {
  /**
   * Instagram hands out the same photo under a new host and a new signed query
   * on every scrape. Keying on the full link would store it once per scrape.
   */
  it("is the same for the same photo across scrapes", () => {
    const a = imagePath("shop", IG("photo", "scontent-iad6-1", "oe=1&sig=a"), "image/jpeg");
    const b = imagePath("shop", IG("photo", "scontent-mad1-1", "oe=2&sig=b"), "image/jpeg");
    expect(a).toBe(b);
  });

  it("differs for different photos", () => {
    expect(imagePath("shop", IG("one"), "image/jpeg")).not.toBe(
      imagePath("shop", IG("two"), "image/jpeg"),
    );
  });

  it("files under the shop, lowercased and safe, with the type's extension", () => {
    expect(imagePath("Lucente.KZ", IG("x"), "image/webp")).toMatch(
      /^lucente\.kz\/[0-9a-f]{20}\.webp$/,
    );
    expect(imagePath("a b/c", IG("x"), "image/png")).toMatch(/^a_b_c\//);
  });
});

describe("mirrorImage", () => {
  it("copies a live image and returns the permanent link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse()));
    const { store, put } = fakeStore();

    const url = await mirrorImage(IG("avatar"), "shop", store);

    expect(put).toHaveBeenCalledTimes(1);
    expect(url).toContain("/storage/v1/object/public/");
  });

  /**
   * REGRESSION target: an image that has already expired answers 403. It must
   * not fail the import — the boutique keeps the link it would have had anyway.
   */
  it("keeps the original link when the image cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status(403)));
    const { store, put } = fakeStore();

    expect(await mirrorImage(IG("dead"), "shop", store)).toBe(IG("dead"));
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the original link when storage refuses the upload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse()));
    const store: ImageStore = { put: vi.fn().mockRejectedValue(new Error("bucket missing")) };

    expect(await mirrorImage(IG("a"), "shop", store)).toBe(IG("a"));
  });

  it("refuses something that is not an image", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse("text/html")));
    const { store, put } = fakeStore();

    expect(await mirrorImage(IG("a"), "shop", store)).toBe(IG("a"));
    expect(put).not.toHaveBeenCalled();
  });

  it("does not re-copy a link that is already ours", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { store } = fakeStore();
    const ours = "https://proj.supabase.co/storage/v1/object/public/boutique-images/shop/a.jpg";

    expect(await mirrorImage(ours, "shop", store)).toBe(ours);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a missing image through", async () => {
    const { store } = fakeStore();
    expect(await mirrorImage(null, "shop", store)).toBeNull();
  });
});

describe("mirrorProfileImages", () => {
  it(`copies the avatar and the first ${MIRRORED_POSTS} posts — what Telegram and the site show`, async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse()));
    const { store, put } = fakeStore();

    const out = await mirrorProfileImages(profile(8), store);

    expect(put).toHaveBeenCalledTimes(1 + MIRRORED_POSTS);
    expect(out.profilePicUrl).toContain("/storage/v1/object/public/");
    for (const post of out.recentPosts.slice(0, MIRRORED_POSTS)) {
      expect(post.imageUrl).toContain("/storage/v1/object/public/");
    }
    // Posts past the shown ones are left alone rather than stored for nothing.
    expect(out.recentPosts[MIRRORED_POSTS]!.imageUrl).toBe(IG(`post${MIRRORED_POSTS}`));
  });

  it("keeps everything else about the posts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse()));
    const { store } = fakeStore();

    const out = await mirrorProfileImages(profile(2), store);

    expect(out.recentPosts.map((p) => p.caption)).toEqual(["p0", "p1"]);
    expect(out.handle).toBe("Lucente.KZ");
  });

  it("copies what it can and keeps the rest when some images are dead", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async (url: string) =>
          url.includes("post1") ? status(403) : imageResponse(),
        ),
    );
    const { store } = fakeStore();

    const out = await mirrorProfileImages(profile(3), store);

    expect(out.recentPosts[0]!.imageUrl).toContain("/storage/v1/object/public/");
    expect(out.recentPosts[1]!.imageUrl).toBe(IG("post1"));
    expect(out.recentPosts[2]!.imageUrl).toContain("/storage/v1/object/public/");
  });

  it("returns the profile UNTOUCHED when storage is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const p = profile(3);

    const out = await mirrorProfileImages(p, null);

    expect(out).toBe(p);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("imageStoreFromEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is off without the secret key — the public anon key cannot write to storage", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(imageStoreFromEnv()).toBeNull();
  });

  it("is on with either name for the secret key", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
    expect(imageStoreFromEnv()).not.toBeNull();
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy-service-role";
    expect(imageStoreFromEnv()).not.toBeNull();
  });
});
