/** Instagram path segments that are not usernames. */
const RESERVED = new Set([
  "p",
  "reel",
  "reels",
  "explore",
  "stories",
  "tv",
  "accounts",
  "about",
  "directory",
]);

/**
 * Extracts a normalized (lowercase) handle from an Instagram profile URL.
 * Returns null when the input is not a usable Instagram profile URL.
 */
export function parseInstagramHandle(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let hostname: string;
  let pathname: string;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    hostname = url.hostname;
    pathname = url.pathname;
  } catch {
    return null;
  }

  if (!/(^|\.)instagram\.com$/i.test(hostname)) return null;

  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;

  const handle = segment.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return null;
  if (RESERVED.has(handle)) return null;

  return handle;
}

export function instagramUrlForHandle(handle: string): string {
  return `https://www.instagram.com/${handle}`;
}
