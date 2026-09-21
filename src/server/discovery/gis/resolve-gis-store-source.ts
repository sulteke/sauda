import "server-only";

import { logger } from "@/lib/logger";

import { GisApifyStoreSource } from "./gis-apify-source";
import { GisApiStoreSource } from "./gis-api-source";
import { GisSourceError, type GisStoreSource } from "./gis-store-source";

/** Which store source to use. Default "api" — the official, permitted path. */
export type GisSourceName = "api" | "apify";

export function configuredGisSource(): GisSourceName {
  return process.env.GIS_STORE_SOURCE?.trim().toLowerCase() === "apify" ? "apify" : "api";
}

/** Builds one source by name, throwing a clear error when it is unconfigured. */
export function buildGisStoreSource(name: GisSourceName): GisStoreSource {
  if (name === "apify") {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
      throw new GisSourceError("APIFY_TOKEN is required for the Apify 2GIS source.");
    }
    return new GisApifyStoreSource({ token });
  }

  const apiKey = process.env.GIS_API_KEY;
  if (!apiKey) {
    throw new GisSourceError(
      "GIS_API_KEY is required for the official 2GIS Places API source. Create a key in the 2GIS Platform Manager.",
    );
  }
  return new GisApiStoreSource({ apiKey });
}

/**
 * The configured source, plus the fallback to try when it yields no contacts.
 *
 * The official API returns NO website or social links unless the key carries
 * the paid `contact_groups` permission — and that is invisible until a real
 * response comes back empty-handed. So when "api" is configured and Apify is
 * also available, we hand the caller both: enumerate with the API, and fall
 * back to Apify only if the venue produced zero Instagram links. Guessing a
 * username is never an option, so a fallback is the only honest alternative.
 */
export function resolveGisStoreSources(): { primary: GisStoreSource; fallback: GisStoreSource | null } {
  const configured = configuredGisSource();
  const primary = buildGisStoreSource(configured);

  let fallback: GisStoreSource | null = null;
  if (configured === "api" && process.env.APIFY_TOKEN && process.env.APIFY_2GIS_ACTOR) {
    try {
      fallback = buildGisStoreSource("apify");
    } catch (error) {
      // A misconfigured fallback must never break the primary path.
      logger.warn("gis.fallback_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { primary, fallback };
}
