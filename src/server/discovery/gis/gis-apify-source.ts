import "server-only";

import { logger } from "@/lib/logger";

import {
  extractInstagramHandle,
  type GisFetchOptions,
  type GisLocation,
  GisSourceError,
  type GisStore,
  type GisStoreSource,
  instagramUrlFor,
} from "./gis-store-source";

/**
 * Apify-backed 2GIS store source — the fallback for when the official Places
 * API key lacks the paid `contact_groups` permission and therefore returns no
 * website or social links at all.
 *
 * It reuses the project's existing APIFY_TOKEN and the same
 * run-sync-get-dataset-items call shape as the Instagram actors, so this adds a
 * configuration, not a second scraping stack. The actor is NOT hardcoded: set
 * APIFY_2GIS_ACTOR to whichever actor the account subscribes to.
 *
 * Actors differ in their input schema, so — exactly as the Instagram hashtag
 * provider already does — we send a UNION of the common field names and let the
 * actor ignore what it does not recognize. That keeps the actor swappable
 * without a code change.
 */

const DEFAULT_BASE_URL = "https://api.apify.com";
const DEFAULT_TIMEOUT_MS = 55_000;

/** Defensive shape: actors vary, so every field is optional and re-checked. */
interface ApifyGisItem {
  id?: string | number;
  gisId?: string | number;
  placeId?: string | number;
  name?: string;
  title?: string;
  address?: string;
  fullAddress?: string;
  phone?: string;
  phones?: unknown;
  website?: string;
  url?: string;
  site?: string;
  instagram?: string;
  socialLinks?: unknown;
  socials?: unknown;
  contacts?: unknown;
  rubric?: string;
  category?: string;
  categories?: unknown;
  latitude?: number;
  longitude?: number;
  lat?: number;
  lon?: number;
  gisUrl?: string;
  link?: string;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Collects every string anywhere in a nested value, for Instagram scanning. */
function deepStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => deepStrings(entry, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      deepStrings(entry, depth + 1),
    );
  }
  return [];
}

export interface GisApifySourceOptions {
  token: string;
  actorId?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class GisApifyStoreSource implements GisStoreSource {
  readonly name = "apify";

  private readonly token: string;
  private readonly actorId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: GisApifySourceOptions) {
    this.token = options.token;
    const actor = options.actorId ?? process.env.APIFY_2GIS_ACTOR;
    if (!actor) {
      throw new GisSourceError(
        "APIFY_2GIS_ACTOR is required to use the Apify 2GIS source (GIS_STORE_SOURCE=apify).",
      );
    }
    this.actorId = actor;
    this.baseUrl = options.baseUrl ?? process.env.APIFY_BASE_URL ?? DEFAULT_BASE_URL;
    const envTimeout = Number(process.env.GIS_APIFY_TIMEOUT_MS);
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  }

  private toStore(item: ApifyGisItem, location: GisLocation): GisStore | null {
    const gisId = firstString(
      typeof item.gisId === "number" ? String(item.gisId) : item.gisId,
      typeof item.id === "number" ? String(item.id) : item.id,
      typeof item.placeId === "number" ? String(item.placeId) : item.placeId,
    );
    const name = firstString(item.name, item.title);
    if (!gisId || !name) return null;

    // Scan every social/contact field for a real instagram.com URL rather than
    // trusting one field name — actors disagree on where they put it.
    const candidates = [
      item.instagram,
      ...deepStrings(item.socialLinks),
      ...deepStrings(item.socials),
      ...deepStrings(item.contacts),
      item.website,
      item.url,
      item.site,
    ];
    let handle: string | null = null;
    for (const candidate of candidates) {
      handle = extractInstagramHandle(candidate);
      if (handle) break;
    }

    const website = firstString(item.website, item.site, item.url);

    return {
      gisId,
      name,
      address: firstString(item.fullAddress, item.address),
      phone: firstString(item.phone, ...deepStrings(item.phones)),
      // Never file an Instagram URL as the website.
      website: website && !/instagram\.com/i.test(website) ? website : null,
      instagramHandle: handle,
      instagramUrl: handle ? instagramUrlFor(handle) : null,
      rubric: firstString(item.rubric, item.category, ...deepStrings(item.categories)),
      latitude: typeof item.latitude === "number" ? item.latitude : (item.lat ?? null),
      longitude: typeof item.longitude === "number" ? item.longitude : (item.lon ?? null),
      locationId: location.id,
      locationName: location.name ?? null,
      gisUrl: firstString(item.gisUrl, item.link) ?? `https://2gis.kz/firm/${gisId}`,
    };
  }

  async fetchStores(location: GisLocation, options: GisFetchOptions = {}): Promise<GisStore[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : undefined;
    const gisUrl =
      location.kind === "building"
        ? `https://2gis.kz/almaty/inside/${location.id}`
        : `https://2gis.kz/almaty/geo/${location.id}`;

    // Union input: actors read the names they know and ignore the rest, so the
    // actor stays swappable via APIFY_2GIS_ACTOR without touching this code.
    const input: Record<string, unknown> = {
      startUrls: [{ url: gisUrl }],
      urls: [gisUrl],
      url: gisUrl,
      buildingId: location.id,
      locationId: location.id,
      ...(limit ? { maxItems: limit, maxResults: limit, resultsLimit: limit } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const url = `${this.baseUrl}/v2/acts/${this.actorId}/run-sync-get-dataset-items?token=${this.token}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new GisSourceError(
          `Apify 2GIS actor failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 300)}` : ""}`,
          { status: response.status },
        );
      }

      const items = (await response.json().catch(() => [])) as ApifyGisItem[];
      const stores: GisStore[] = [];
      const seen = new Set<string>();
      for (const item of Array.isArray(items) ? items : []) {
        const store = this.toStore(item, location);
        if (!store || seen.has(store.gisId)) continue;
        seen.add(store.gisId);
        stores.push(store);
        if (limit && stores.length >= limit) break;
      }

      logger.info("gis.apify.enumerated", {
        source: this.name,
        actorId: this.actorId,
        locationId: location.id,
        returned: Array.isArray(items) ? items.length : 0,
        stores: stores.length,
        withInstagram: stores.filter((store) => store.instagramHandle).length,
        durationMs: Date.now() - startedAt,
      });

      return stores;
    } catch (error) {
      if (error instanceof GisSourceError) throw error;
      if ((error as { name?: string })?.name === "AbortError") {
        throw new GisSourceError(`Apify 2GIS actor timed out after ${this.timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GisSourceError(`Apify 2GIS actor error: ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
