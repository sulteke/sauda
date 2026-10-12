/**
 * Instagram serves images from signed CDN links that stop working a few days
 * after they were scraped. The `oe` parameter is the moment a link expires, as
 * Unix seconds in hex; past it the CDN answers 403. Telegram, asked to fetch
 * such a link for an album, rejects the WHOLE album with WEBPAGE_CURL_FAILED —
 * forty-two approved boutiques sat in FAILED for exactly this, and Retry only
 * re-sent the same dead links.
 *
 * Reading the expiry costs no request, so a dead link is known before anything
 * is sent.
 */

/** Failure code for a publication whose every image link has expired. */
export const IMAGES_EXPIRED = "IMAGES_EXPIRED";

/** Failure code for a publication whose live links all sit on hosts Telegram cannot reach. */
export const IMAGES_UNREACHABLE = "IMAGES_UNREACHABLE";

/**
 * Whether a publication failed because of this boutique's stored images —
 * a fault only a re-parse fixes, and no sign that the channel itself is failing.
 */
export function isImageFault(code: string | null | undefined): boolean {
  return code === IMAGES_EXPIRED || code === IMAGES_UNREACHABLE;
}

/** Posts shown in a publication, after the avatar. */
export const ALBUM_POSTS = 6;

/**
 * Links this close to expiring count as gone already: Telegram fetches them
 * after we check, and a post that dies on the way is the failure this avoids.
 */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/**
 * When the link stops working, or null when it carries no expiry — a copy in
 * our own storage, or anything that is not Instagram's CDN. Those are never
 * treated as expired.
 */
export function imageLinkExpiresAt(url: string): Date | null {
  let oe: string | null;
  try {
    oe = new URL(url).searchParams.get("oe");
  } catch {
    return null;
  }
  if (!oe || !/^[0-9a-f]{1,12}$/i.test(oe)) return null;
  return new Date(parseInt(oe, 16) * 1000);
}

export function isImageLinkExpired(url: string, now: number = Date.now()): boolean {
  const expiresAt = imageLinkExpiresAt(url);
  return expiresAt !== null && expiresAt.getTime() - EXPIRY_MARGIN_MS <= now;
}

/** Whether the link is served by Instagram's CDN, on any of its edge hosts. */
export function isInstagramCdnLink(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith(".cdninstagram.com") || hostname.endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

/** The images a publication shows: the avatar, then the first posts. */
export function albumImageUrls(
  avatarUrl: string | null,
  posts: readonly { imageUrl: string | null }[],
): string[] {
  return [avatarUrl, ...posts.slice(0, ALBUM_POSTS).map((post) => post.imageUrl)].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
}

/**
 * True when the boutique has images and every one of them has expired. Only a
 * fresh scrape brings them back; retrying sends the same dead links.
 */
export function allImagesExpired(
  avatarUrl: string | null,
  posts: readonly { imageUrl: string | null }[],
  now: number = Date.now(),
): boolean {
  const urls = albumImageUrls(avatarUrl, posts);
  return urls.length > 0 && urls.every((url) => isImageLinkExpired(url, now));
}
