import "server-only";

import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Copies a boutique's images into our own storage, so the links we keep do not
 * die.
 *
 * Instagram serves profile and post images from signed CDN links that expire
 * about five days after they are issued. We stored those links and nothing
 * else, so a boutique scraped more than a few days earlier pointed at images
 * that answered 403: 116 of 129 approved boutiques had dead images, the public
 * site showed them empty, and Telegram — which fetches a post's photos by URL —
 * rejected every album with WEBPAGE_CURL_FAILED.
 *
 * The only moment the links are alive is right after the scrape, so that is
 * where this runs. It never fails an import: an image it cannot copy keeps its
 * original link, exactly as before.
 */

/** Posts whose images are copied — the ones Telegram and the site show. */
export const MIRRORED_POSTS = 6;
export const DEFAULT_IMAGE_BUCKET = "boutique-images";
const FETCH_TIMEOUT_MS = 15_000;
/** Marks a link that already points into our storage. */
const OWN_STORAGE_MARKER = "/storage/v1/object/public/";

/** Somewhere to keep image bytes under a link that does not expire. */
export interface ImageStore {
  put(path: string, body: ArrayBuffer, contentType: string): Promise<string>;
}

/**
 * The Supabase Storage bucket, or null when it is not configured.
 *
 * Needs the project's SECRET key: writing to storage from the server is not
 * something the public anon key may do. Without it this returns null and
 * imports keep the original links — the behaviour before this existed.
 */
export function imageStoreFromEnv(): ImageStore | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const bucket = process.env.IMAGE_BUCKET || DEFAULT_IMAGE_BUCKET;
  const client = createClient(url, key, { auth: { persistSession: false } });

  return {
    async put(path, body, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, body, { contentType, upsert: true });
      if (error) throw error;
      return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    },
  };
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

/**
 * Where an image is kept: the shop, then a hash of the image's CDN PATH.
 *
 * The path, not the full link. Instagram hands out the same image under a new
 * host and a new signed query on every scrape, so keying on the full link would
 * store one photo once per scrape; its path is the same each time, so a
 * re-scrape overwrites the copy it already has instead of piling up duplicates.
 */
export function imagePath(handle: string, sourceUrl: string, contentType: string): string {
  let key = sourceUrl;
  try {
    key = new URL(sourceUrl).pathname;
  } catch {
    // Not a URL we can parse; hash it whole.
  }
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  const ext = EXTENSION_BY_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? "jpg";
  const safeHandle = handle.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "unknown";
  return `${safeHandle}/${hash}.${ext}`;
}

/**
 * Copies one image and returns its permanent link — or the original link, if it
 * could not be copied. Never throws.
 */
export async function mirrorImage(
  sourceUrl: string | null,
  handle: string,
  store: ImageStore,
): Promise<string | null> {
  if (!sourceUrl) return sourceUrl;
  // Already ours: copying it again would only fetch our own file back.
  if (sourceUrl.includes(OWN_STORAGE_MARKER)) return sourceUrl;

  try {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) throw new Error(`not an image (${contentType})`);
    const body = await response.arrayBuffer();
    return await store.put(imagePath(handle, sourceUrl, contentType), body, contentType);
  } catch (error) {
    logger.warn("image_mirror.failed", {
      handle,
      error: error instanceof Error ? error.message : String(error),
    });
    return sourceUrl;
  }
}

interface MirrorableProfile {
  handle: string;
  profilePicUrl: string | null;
  recentPosts: { imageUrl: string | null }[];
}

/**
 * Returns the profile with its avatar and first posts pointing at our copies.
 *
 * Applied to the profile as it arrives from the scraper, before anything is
 * built from it — the stored profile, the preview and the boutique all derive
 * from this object, and later stages rebuild the preview from the stored
 * profile. Copying any later would leave the stored profile holding the
 * expiring links, and the next rebuild would write them back over the copies.
 *
 * Unconfigured, it returns the profile untouched.
 */
export async function mirrorProfileImages<T extends MirrorableProfile>(
  profile: T,
  store: ImageStore | null = imageStoreFromEnv(),
): Promise<T> {
  if (!store) return profile;

  const handle = profile.handle;
  const posts = profile.recentPosts;
  const [avatar, ...postImages] = await Promise.all([
    mirrorImage(profile.profilePicUrl, handle, store),
    ...posts.slice(0, MIRRORED_POSTS).map((post) => mirrorImage(post.imageUrl, handle, store)),
  ]);

  const mirroredPosts = posts.map((post, i) =>
    i < MIRRORED_POSTS ? { ...post, imageUrl: postImages[i] ?? post.imageUrl } : post,
  );

  const copied = [avatar, ...postImages].filter((u) => u?.includes(OWN_STORAGE_MARKER)).length;
  logger.info("image_mirror.profile", {
    handle,
    copied,
    attempted: 1 + Math.min(posts.length, MIRRORED_POSTS),
  });

  return { ...profile, profilePicUrl: avatar ?? profile.profilePicUrl, recentPosts: mirroredPosts };
}
