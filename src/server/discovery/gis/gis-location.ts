import { GisLocationError, type GisLocation } from "./gis-store-source";

/**
 * Turning whatever an admin pastes into a 2GIS venue.
 *
 * The 2GIS apps share places as `go.2gis.com/XXXXX` short links, and those
 * resolve to a FIRM (one business), not to the venue it sits in — even when the
 * business IS a mall. So accepting a share link means two lookups: follow the
 * short link one hop, then ask the Places API which building that firm is in.
 *
 * Everything that can be read without the network still is: a bare id, an
 * `/inside/` URL or an explicit prefix never costs a request.
 */

/** Hosts 2GIS uses for share links. */
const SHORT_LINK_HOST = /^go\.2gis\.[a-z.]+$/i;
const GIS_HOST = /(^|\.)2gis\.[a-z.]+$/i;
const DEFAULT_TIMEOUT_MS = 10_000;

/** What an input turned out to be, before any network call. */
export type GisInput =
  | { kind: "location"; location: GisLocation }
  | { kind: "firm"; firmId: string }
  | { kind: "short"; url: string };

function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Classifies the input WITHOUT touching the network.
 *
 * Accepts: a bare numeric id, `building:<id>` / `place:<id>`, a 2GIS
 * `/inside/<id>` or `/geo/<id>` URL, a `/firm/<id>` URL, or a go.2gis.com
 * share link. The last two need resolving; the rest are already venues.
 */
export function parseGisInput(input: string, name?: string | null): GisInput {
  const trimmed = input.trim();
  if (!trimmed) throw new GisLocationError("Enter a 2GIS location URL, share link, or building id.");

  const prefixed = /^(building|place)\s*:\s*(\d{6,})$/i.exec(trimmed);
  if (prefixed?.[1] && prefixed[2]) {
    return {
      kind: "location",
      location: { kind: prefixed[1].toLowerCase() as "building" | "place", id: prefixed[2], name },
    };
  }

  if (/^\d{6,}$/.test(trimmed)) {
    return { kind: "location", location: { kind: "building", id: trimmed, name } };
  }

  let url: URL | null = null;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    url = null;
  }

  if (url && SHORT_LINK_HOST.test(url.hostname)) {
    if (url.pathname.replace(/\//g, "").length === 0) {
      throw new GisLocationError("That 2GIS share link has no code in it.");
    }
    return { kind: "short", url: url.toString() };
  }

  if (url && GIS_HOST.test(url.hostname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const index = segments.findIndex((segment) =>
      ["inside", "geo", "building", "firm"].includes(segment),
    );
    const kind = index >= 0 ? segments[index] : null;
    const id = index >= 0 ? segments[index + 1] : null;

    if (id && /^\d{6,}$/.test(id)) {
      // A firm is one business; its venue is looked up separately.
      if (kind === "firm") return { kind: "firm", firmId: id };
      return { kind: "location", location: { kind: kind === "geo" ? "place" : "building", id, name } };
    }
  }

  throw new GisLocationError(
    "Could not read a 2GIS location. Paste a 2GIS share link (go.2gis.com/…), a 2gis.kz/…/inside/<id> link, or the numeric building id.",
  );
}

export interface ResolveOptions {
  name?: string | null;
  /** 2GIS Places API key. Defaults to GIS_API_KEY. */
  apiKey?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Follows a share link exactly ONE hop and returns where it points.
 *
 * Deliberately `redirect: "manual"`: the second hop is 2GIS's anti-bot
 * interstitial (`/museum?return_url=…`), which carries no venue information and
 * would only get us blocked. The first Location header already holds the real
 * URL, so one hop is both sufficient and the polite thing to do.
 */
export async function resolveShortLink(
  shortUrl: string,
  options: ResolveOptions = {},
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const { signal, clear } = timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(shortUrl, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (!location) {
      throw new GisLocationError(
        `That 2GIS share link did not redirect anywhere (HTTP ${response.status}). Check that the link is complete.`,
      );
    }
    return new URL(location, shortUrl).toString();
  } catch (error) {
    if (error instanceof GisLocationError) throw error;
    if ((error as { name?: string })?.name === "AbortError") {
      throw new GisLocationError("Timed out following the 2GIS share link.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GisLocationError(`Could not follow the 2GIS share link: ${message}`);
  } finally {
    clear();
  }
}

/**
 * Asks the Places API which building a firm sits in.
 *
 * `address.building_id` is the venue we can actually enumerate; the firm id
 * alone would return just that one business.
 */
export async function resolveFirmBuilding(
  firmId: string,
  options: ResolveOptions = {},
): Promise<GisLocation> {
  const apiKey = options.apiKey ?? process.env.GIS_API_KEY;
  if (!apiKey) {
    throw new GisLocationError(
      "That link points to a single business, and resolving it to its building needs the 2GIS Places API. Set GIS_API_KEY, or paste the venue's own /inside/<id> link instead.",
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const { signal, clear } = timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      id: firmId,
      key: apiKey,
      locale: process.env.GIS_LOCALE ?? "ru_KZ",
      fields: "items.address",
    });
    const base = process.env.GIS_API_BASE_URL ?? "https://catalog.api.2gis.com";
    // The key lives only in the query string; never log this URL.
    const response = await doFetch(`${base}/3.0/items/byid?${params.toString()}`, { signal });
    const body = (await response.json().catch(() => ({}))) as {
      meta?: { code?: number; error?: { message?: string } };
      result?: { items?: { name?: string; address?: { building_id?: string; building_name?: string } }[] };
    };

    const code = body.meta?.code ?? response.status;
    if (code !== 200) {
      throw new GisLocationError(
        `2GIS could not identify that business (${code}${body.meta?.error?.message ? `: ${body.meta.error.message}` : ""}).`,
      );
    }

    const item = body.result?.items?.[0];
    const buildingId = item?.address?.building_id;
    if (!buildingId) {
      throw new GisLocationError(
        `2GIS has no building recorded for "${item?.name ?? firmId}", so its neighbours cannot be enumerated. Open the venue on 2GIS and use its /inside/<id> link.`,
      );
    }

    return {
      kind: "building",
      id: buildingId,
      name: options.name ?? item?.address?.building_name ?? null,
    };
  } catch (error) {
    if (error instanceof GisLocationError) throw error;
    if ((error as { name?: string })?.name === "AbortError") {
      throw new GisLocationError("Timed out asking 2GIS which building that business is in.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GisLocationError(`Could not resolve the business to a building: ${message}`);
  } finally {
    clear();
  }
}

/**
 * The full resolution: whatever was pasted → a venue we can enumerate.
 *
 * Costs nothing for ids and `/inside/` links, one request for a share link that
 * already points at a venue, and two for a share link to a business.
 */
export async function resolveGisLocation(
  input: string,
  options: ResolveOptions = {},
): Promise<GisLocation> {
  const parsed = parseGisInput(input, options.name);

  if (parsed.kind === "location") return parsed.location;
  if (parsed.kind === "firm") return resolveFirmBuilding(parsed.firmId, options);

  // Share link: one hop, then re-read the destination.
  const destination = await resolveShortLink(parsed.url, options);
  const followed = parseGisInput(destination, options.name);
  if (followed.kind === "location") return followed.location;
  if (followed.kind === "firm") return resolveFirmBuilding(followed.firmId, options);

  // A share link that resolves to another share link is not something 2GIS does.
  throw new GisLocationError("That 2GIS share link did not resolve to a location.");
}

/** Back-compat: the synchronous subset, for inputs that need no network. */
export function parseGisLocation(input: string, name?: string | null): GisLocation {
  const parsed = parseGisInput(input, name);
  if (parsed.kind === "location") return parsed.location;
  throw new GisLocationError(
    "That link points to a single business or a share link; it must be resolved before use.",
  );
}
