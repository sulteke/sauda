import { describe, expect, it } from "vitest";

import {
  ALBUM_POSTS,
  albumImageUrls,
  allImagesExpired,
  imageLinkExpiresAt,
  isImageLinkExpired,
  isInstagramCdnLink,
} from "./instagram-image";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3600 * 1000;

/** An Instagram CDN link that expires at the given moment. */
const ig = (expiresAtMs: number, name = "p") =>
  `https://scontent-ams2-1.cdninstagram.com/v/t51.2885-15/${name}.jpg?stp=dst-jpg&oe=${Math.floor(
    expiresAtMs / 1000,
  )
    .toString(16)
    .toUpperCase()}&_nc_sid=abc`;

const ours = "https://proj.supabase.co/storage/v1/object/public/boutique-images/shop/a.jpg";

describe("imageLinkExpiresAt", () => {
  it("reads the expiry Instagram signs into the link", () => {
    expect(imageLinkExpiresAt(ig(NOW + 5 * HOUR))?.getTime()).toBe(NOW + 5 * HOUR);
  });

  it("is null for a link with no expiry — our storage never expires", () => {
    expect(imageLinkExpiresAt(ours)).toBeNull();
  });

  it("is null for something that is not a link", () => {
    expect(imageLinkExpiresAt("not a url")).toBeNull();
  });
});

describe("isImageLinkExpired", () => {
  it("is expired once the signed moment has passed", () => {
    expect(isImageLinkExpired(ig(NOW - 72 * HOUR), NOW)).toBe(true);
  });

  it("is alive while there is time left", () => {
    expect(isImageLinkExpired(ig(NOW + 38 * HOUR), NOW)).toBe(false);
  });

  it("counts a link about to expire as gone — Telegram fetches it after we check", () => {
    expect(isImageLinkExpired(ig(NOW + 60 * 1000), NOW)).toBe(true);
  });

  it("never calls a link without an expiry dead", () => {
    expect(isImageLinkExpired(ours, NOW)).toBe(false);
  });
});

describe("albumImageUrls", () => {
  it(`is the avatar and the first ${ALBUM_POSTS} posts, skipping the empty ones`, () => {
    const posts = Array.from({ length: 9 }, (_, i) => ({ imageUrl: i === 1 ? null : `p${i}` }));
    expect(albumImageUrls("avatar", posts)).toEqual(["avatar", "p0", "p2", "p3", "p4", "p5"]);
  });
});

describe("allImagesExpired", () => {
  const dead = ig(NOW - HOUR);
  const live = ig(NOW + 48 * HOUR);

  it("is true when every image has expired", () => {
    expect(allImagesExpired(dead, [{ imageUrl: dead }, { imageUrl: dead }], NOW)).toBe(true);
  });

  it("is false while any image is alive — those can still be sent", () => {
    expect(allImagesExpired(dead, [{ imageUrl: live }], NOW)).toBe(false);
  });

  it("is false for a boutique with no images at all — nothing has expired", () => {
    expect(allImagesExpired(null, [], NOW)).toBe(false);
  });
});

describe("Instagram CDN hosts", () => {
  it("knows Instagram's edge hosts from everything else", () => {
    expect(isInstagramCdnLink("https://scontent-ams2-1.cdninstagram.com/v/a.jpg")).toBe(true);
    expect(isInstagramCdnLink("https://instagram.fcps4-2.fna.fbcdn.net/v/a.jpg")).toBe(true);
    expect(isInstagramCdnLink(ours)).toBe(false);
    expect(isInstagramCdnLink("not a url")).toBe(false);
  });
});
