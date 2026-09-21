import "server-only";

import { logger } from "@/lib/logger";

import { FASHION_QUERIES } from "./gis-rubric-filter";
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
  // Contacts arrive as ARRAYS from the verified actor (phoneText, website),
  // while other actors use plain strings — both shapes are accepted.
  phone?: unknown;
  phones?: unknown;
  phoneText?: unknown;
  phoneValue?: unknown;
  website?: unknown;
  site?: unknown;
  url?: string;
  instagram?: string;
  socialLinks?: unknown;
  socials?: unknown;
  contacts?: unknown;
  // Human-readable categories. `category` is an INTERNAL code on the verified
  // actor ("common_store"), so it is never used for the fashion decision.
  rubrics?: unknown;
  rubric?: string;
  category?: string;
  categories?: unknown;
  latitude?: number;
  longitude?: number;
  lat?: number;
  lon?: number;
  location?: { lat?: number; lng?: number; lon?: number };
  gisUrl?: string;
  link?: string;
}

/**
 * First usable string among the candidates, flattening one level of array.
 * The verified actor returns `website: ["http://kimex.kz"]` and
 * `phoneText: ["+7...", "+7..."]`, so a string-only reader silently dropped
 * every contact it had.
 */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const found = value.find((v) => typeof v === "string" && v.trim());
      if (typeof found === "string") return found.trim();
    }
  }
  return null;
}

/** Every string in a value that may be a string or an array of strings. */
function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  return [];
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
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
    // trusting one field name — actors disagree on where they put it. The
    // verified actor files it under socials.other[], beside VK and Telegram.
    const candidates = [
      item.instagram,
      ...deepStrings(item.socials),
      ...deepStrings(item.socialLinks),
      ...deepStrings(item.contacts),
      ...stringList(item.website),
      ...stringList(item.site),
    ];
    let handle: string | null = null;
    for (const candidate of candidates) {
      handle = extractInstagramHandle(candidate);
      if (handle) break;
    }

    // The store's OWN site only. `item.url` is the 2GIS listing page, which is
    // provenance, not a website — filing it here would mask a missing one.
    const website = [...stringList(item.website), ...stringList(item.site)].find(
      (value) => !/instagram\.com/i.test(value) && !/2gis\./i.test(value),
    );

    // Human-readable categories, primary first. `category` holds an internal
    // code on the verified actor, so it is only a last-resort fallback.
    const rubrics = [
      ...stringList(item.rubrics),
      ...stringList(item.rubric),
      ...stringList(item.categories),
    ];

    return {
      gisId,
      name,
      address: firstString(item.fullAddress, item.address),
      phone: firstString(item.phoneText, item.phoneValue, item.phone, item.phones),
      website: website ?? null,
      instagramHandle: handle,
      instagramUrl: handle ? instagramUrlFor(handle) : null,
      rubric: rubrics[0] ?? firstString(item.category),
      rubrics: rubrics.length > 0 ? rubrics : null,
      latitude: firstNumber(item.location?.lat, item.latitude, item.lat),
      longitude: firstNumber(item.location?.lng, item.location?.lon, item.longitude, item.lon),
      locationId: location.id,
      locationName: location.name ?? null,
      gisUrl: firstString(item.gisUrl, item.link, item.url) ?? `https://2gis.kz/firm/${gisId}`,
    };
  }

  /**
   * The input property names this actor accepts.
   *
   * Actors validate strictly — the verified one rejects the whole run with
   * "Property input.startUrls is not allowed" — so a blind union of field names
   * cannot work. Reading the actor's own schema keeps the union approach (and
   * therefore actor swappability) while sending only what it will accept.
   * A schema we cannot read is not fatal: we fall back to sending everything.
   */
  private async allowedInputKeys(): Promise<Set<string> | null> {
    try {
      const actor = await fetch(
        `${this.baseUrl}/v2/acts/${this.actorId}?token=${this.token}`,
      ).then((r) => (r.ok ? r.json() : null));
      const buildId = actor?.data?.taggedBuilds?.latest?.buildId;
      if (!buildId) return null;
      const build = await fetch(
        `${this.baseUrl}/v2/actor-builds/${buildId}?token=${this.token}`,
      ).then((r) => (r.ok ? r.json() : null));
      const raw = build?.data?.inputSchema;
      if (!raw) return null;
      const schema = typeof raw === "string" ? JSON.parse(raw) : raw;
      const keys = Object.keys(schema?.properties ?? {});
      return keys.length > 0 ? new Set(keys) : null;
    } catch {
      return null; // never let schema discovery break a run
    }
  }

  async fetchStores(location: GisLocation, options: GisFetchOptions = {}): Promise<GisStore[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : undefined;
    const gisUrl =
      location.kind === "building"
        ? `https://2gis.kz/almaty/inside/${location.id}`
        : `https://2gis.kz/almaty/geo/${location.id}`;

    // Search terms partition the venue the same way the official source does.
    const queries = FASHION_QUERIES.filter(Boolean);
    // maxItems is PER QUERY on the verified actor, and it bills per result, so
    // the cap is divided across queries to keep a bounded run genuinely bounded.
    const perQuery = limit ? Math.max(1, Math.ceil(limit / queries.length)) : undefined;

    const union: Record<string, unknown> = {
      // Venue, by whichever name the actor uses.
      buildingIds: [location.id],
      buildingId: location.id,
      locationId: location.id,
      startUrls: [{ url: gisUrl }],
      urls: [gisUrl],
      url: gisUrl,
      // What to look for, and where.
      query: queries,
      domain: process.env.GIS_APIFY_DOMAIN ?? "2gis.kz",
      language: process.env.GIS_APIFY_LANGUAGE ?? "ru",
      // Contacts are the whole point of this source: it opens each org page to
      // collect website and social links, which the official API gates behind
      // a paid add-on.
      includeContacts: true,
      ...(perQuery ? { maxItems: perQuery, maxResults: perQuery, resultsLimit: perQuery } : {}),
    };

    const allowed = await this.allowedInputKeys();
    const input = allowed
      ? Object.fromEntries(Object.entries(union).filter(([key]) => allowed.has(key)))
      : union;

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
        // Queries overlap, so the same store commonly appears more than once.
        if (!store || seen.has(store.gisId)) continue;
        seen.add(store.gisId);
        stores.push(store);
        if (limit && stores.length >= limit) break;
      }

      logger.info("gis.apify.enumerated", {
        source: this.name,
        actorId: this.actorId,
        locationId: location.id,
        queries: queries.length,
        maxItemsPerQuery: perQuery ?? null,
        inputFiltered: Boolean(allowed),
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
