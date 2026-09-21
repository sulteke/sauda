import "server-only";

import { parseInstagramHandle } from "@/server/import/instagram-url";

/**
 * The 2GIS store-source seam.
 *
 * Location-first discovery needs exactly one thing from 2GIS: the list of
 * businesses at a venue, normalized. WHERE that list comes from — the official
 * Places API or an Apify actor — is an implementation detail, so both sources
 * implement this interface and nothing downstream can tell them apart.
 *
 * The seam exists because the two sources have genuinely different strengths:
 * the official API is stable and permitted but exposes contacts only to keys
 * with a paid add-on, while the Apify actor can surface social links without
 * that add-on at the cost of a third-party dependency.
 */

/** A business at a 2GIS venue, normalized identically by every source. */
export interface GisStore {
  /** 2GIS object id — the dedup key for this store across runs. */
  gisId: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  /** Only ever a link the source actually published — never a guess. */
  instagramUrl?: string | null;
  instagramHandle?: string | null;
  /** Primary category as 2GIS labels it, e.g. "Женская одежда". This is the
   *  one the fashion filter judges; it is the store's identity in 2GIS. */
  rubric?: string | null;
  /** Every category 2GIS lists, primary first. Kept for review and auditing. */
  rubrics?: readonly string[] | null;
  latitude?: number | null;
  longitude?: number | null;
  locationId?: string | null;
  locationName?: string | null;
  gisUrl?: string | null;
}

/** Which venue to enumerate. A building is one address; a place is a territory. */
export interface GisLocation {
  kind: "building" | "place";
  id: string;
  /** Human-readable venue name, when the caller knows it. */
  name?: string | null;
}

export interface GisFetchOptions {
  /**
   * Hard cap on stores returned. Exists so a first run against a new venue can
   * be verified cheaply before enumerating hundreds; omit it for a full pass.
   */
  limit?: number;
  /** Stop after this many pages regardless of `total`. Safety valve. */
  maxPages?: number;
}

export interface GisStoreSource {
  /** "api" or "apify" — recorded on every store for provenance. */
  readonly name: string;
  fetchStores(location: GisLocation, options?: GisFetchOptions): Promise<GisStore[]>;
}

/** Raised when a store source fails in a way the caller should surface. */
export class GisSourceError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GisSourceError";
    this.status = options.status;
  }
}

/** Raised when the admin's location input cannot be understood. */
export class GisLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GisLocationError";
  }
}

/**
 * Pulls a usable Instagram handle out of arbitrary text — a contact value, a
 * website field, a free-text description. Returns null unless the text contains
 * a real instagram.com profile URL, because a store name is NOT evidence of a
 * username: guessing one would silently import the wrong account.
 */
export function extractInstagramHandle(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  const direct = parseInstagramHandle(value);
  if (direct) return direct;

  // A URL embedded in longer text (e.g. "Мы в инстаграм: instagram.com/foo").
  const match = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s"'<>)\],]+/i.exec(value);
  return match ? parseInstagramHandle(match[0]) : null;
}

/** Canonical profile URL for a normalized handle. */
export function instagramUrlFor(handle: string): string {
  return `https://www.instagram.com/${handle}`;
}
