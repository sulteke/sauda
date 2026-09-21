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
 * Official 2GIS Places API store source.
 *
 * Docs: https://docs.2gis.com/en/api/search/places/reference/3.0/items
 * Enumerates businesses at a venue with `building_id` / `place_id`, which is
 * exactly the location-first primitive this feature needs.
 *
 * `items.contact_groups` (website + social links) requires a PAID permission on
 * the key. We always request it and degrade silently when it is absent: the API
 * simply omits the field, stores come back without contacts, and the caller
 * falls back to the Apify source rather than guessing an Instagram username.
 */

const DEFAULT_BASE_URL = "https://catalog.api.2gis.com";
/** The API's own maximum; anything larger is rejected. */
export const MAX_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Safety valve so a malformed `total` cannot spin the paginator forever. */
export const DEFAULT_MAX_PAGES = 40;

/** Fields we ask for. Contact groups may be denied; the rest are always free. */
const FIELDS = [
  "items.address",
  "items.point",
  "items.rubrics",
  "items.contact_groups",
  "items.external_content",
].join(",");

interface GisContact {
  type?: string;
  value?: string;
  url?: string;
  text?: string;
}

interface GisApiItem {
  id?: string;
  name?: string;
  full_name?: string;
  address_name?: string;
  full_address_name?: string;
  point?: { lat?: number; lon?: number };
  rubrics?: { name?: string }[];
  contact_groups?: { contacts?: GisContact[] }[];
}

interface GisApiResponse {
  meta?: { code?: number; error?: { message?: string } };
  result?: { total?: number; items?: GisApiItem[] };
}

/** Every string a contact carries — 2GIS uses `value`, `url` and `text` unevenly. */
function contactStrings(contact: GisContact): string[] {
  return [contact.value, contact.url, contact.text].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/** Flattens the nested contact groups into a flat contact list. */
function allContacts(item: GisApiItem): GisContact[] {
  return (item.contact_groups ?? []).flatMap((group) => group.contacts ?? []);
}

/**
 * Picks the store's website: the first contact 2GIS labels as a website, and
 * never an Instagram/social URL (those are handled separately).
 */
function pickWebsite(contacts: GisContact[]): string | null {
  for (const contact of contacts) {
    if (contact.type !== "website") continue;
    const value = contactStrings(contact)[0];
    if (value && !/instagram\.com/i.test(value)) return value;
  }
  return null;
}

function pickPhone(contacts: GisContact[]): string | null {
  const phone = contacts.find((contact) => contact.type === "phone");
  return phone ? (contactStrings(phone)[0] ?? null) : null;
}

/**
 * Finds an Instagram handle among the contacts. Scans EVERY contact rather than
 * trusting a `type: "instagram"` label, because 2GIS also files social profiles
 * under generic types — and an instagram.com URL is unambiguous wherever it sits.
 */
function pickInstagram(contacts: GisContact[]): string | null {
  for (const contact of contacts) {
    for (const value of contactStrings(contact)) {
      const handle = extractInstagramHandle(value);
      if (handle) return handle;
    }
  }
  return null;
}

export interface GisApiSourceOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  locale?: string;
}

export class GisApiStoreSource implements GisStoreSource {
  readonly name = "api";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly locale: string;

  constructor(options: GisApiSourceOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? process.env.GIS_API_BASE_URL ?? DEFAULT_BASE_URL;
    const envTimeout = Number(process.env.GIS_TIMEOUT_MS);
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.locale = options.locale ?? process.env.GIS_LOCALE ?? "ru_KZ";
  }

  /** The key lives only in the query string; never log this URL. */
  private endpoint(location: GisLocation, page: number, pageSize: number): string {
    const params = new URLSearchParams({
      key: this.apiKey,
      locale: this.locale,
      type: "branch",
      fields: FIELDS,
      page: String(page),
      page_size: String(pageSize),
    });
    params.set(location.kind === "building" ? "building_id" : "place_id", location.id);
    return `${this.baseUrl}/3.0/items?${params.toString()}`;
  }

  private async fetchPage(
    location: GisLocation,
    page: number,
    pageSize: number,
  ): Promise<{ items: GisApiItem[]; total: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint(location, page, pageSize), {
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as GisApiResponse;

      // 2GIS reports its real status in meta.code, not only the HTTP status.
      const code = body.meta?.code ?? response.status;
      if (!response.ok || (code !== 200 && code !== 204)) {
        // 404 with a page beyond the end simply means "no more results".
        if (code === 404 && page > 1) return { items: [], total: 0 };
        throw new GisSourceError(
          `2GIS Places API failed (${code}${body.meta?.error?.message ? `: ${body.meta.error.message}` : ""})`,
          { status: code },
        );
      }

      return { items: body.result?.items ?? [], total: body.result?.total ?? 0 };
    } catch (error) {
      if (error instanceof GisSourceError) throw error;
      if ((error as { name?: string })?.name === "AbortError") {
        throw new GisSourceError(`2GIS request timed out after ${this.timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GisSourceError(`2GIS request error: ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private toStore(item: GisApiItem, location: GisLocation): GisStore | null {
    const gisId = typeof item.id === "string" ? item.id : null;
    const name = (item.name ?? item.full_name ?? "").trim();
    if (!gisId || !name) return null; // unusable without an identity

    const contacts = allContacts(item);
    const handle = pickInstagram(contacts);

    return {
      gisId,
      name,
      address: item.full_address_name ?? item.address_name ?? null,
      phone: pickPhone(contacts),
      website: pickWebsite(contacts),
      instagramHandle: handle,
      instagramUrl: handle ? instagramUrlFor(handle) : null,
      rubric: item.rubrics?.[0]?.name ?? null,
      latitude: item.point?.lat ?? null,
      longitude: item.point?.lon ?? null,
      locationId: location.id,
      locationName: location.name ?? null,
      gisUrl: `https://2gis.kz/firm/${gisId}`,
    };
  }

  /**
   * Walks every page for the venue, bounded by `limit`, the reported `total`
   * and a hard page cap. Stops early on an empty page, so a `total` that
   * disagrees with reality can never loop.
   */
  async fetchStores(location: GisLocation, options: GisFetchOptions = {}): Promise<GisStore[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const pageSize = Math.min(MAX_PAGE_SIZE, Number.isFinite(limit) ? limit : MAX_PAGE_SIZE);

    const stores: GisStore[] = [];
    const seen = new Set<string>();
    let total = 0;
    let page = 1;

    for (; page <= maxPages; page += 1) {
      const result = await this.fetchPage(location, page, pageSize);
      if (page === 1) total = result.total;
      if (result.items.length === 0) break;

      for (const item of result.items) {
        const store = this.toStore(item, location);
        // Dedup inside the run: paging can repeat an item as results shift.
        if (!store || seen.has(store.gisId)) continue;
        seen.add(store.gisId);
        stores.push(store);
        if (stores.length >= limit) break;
      }

      if (stores.length >= limit) break;
      if (total > 0 && page * pageSize >= total) break;
    }

    const withContacts = stores.filter((store) => store.website || store.instagramHandle).length;
    logger.info("gis.api.enumerated", {
      source: this.name,
      locationKind: location.kind,
      locationId: location.id,
      pages: Math.min(page, maxPages),
      total,
      stores: stores.length,
      withContacts,
      // 0 contacts across a whole venue is the signature of a key WITHOUT the
      // paid contact_groups permission — the caller uses this to fall back.
      contactsAvailable: withContacts > 0,
    });

    return stores;
  }
}
