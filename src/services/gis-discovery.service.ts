import "server-only";

import { Prisma } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { parseGisLocation } from "@/server/discovery/gis/gis-location";
import { partitionByRubric } from "@/server/discovery/gis/gis-rubric-filter";
import type { GisLocation, GisStore, GisStoreSource } from "@/server/discovery/gis/gis-store-source";
import { resolveGisStoreSources } from "@/server/discovery/gis/resolve-gis-store-source";

/**
 * 2GIS location discovery — the LOCATION-FIRST entry point.
 *
 *   venue → businesses → fashion filter → Instagram resolution → DiscoveryCandidate
 *
 * It deliberately stops at the candidate. Nothing here scrapes Instagram,
 * calls the AI, or publishes: those belong to the EXISTING pipeline, which a
 * candidate enters through the unchanged Auto Import flow. So this runs on no
 * AI budget at all, and the 20/day analysis and publication limits are
 * untouched by a 2GIS run of any size.
 */

export interface GisDiscoveryResult {
  locationId: string;
  locationKind: "building" | "place";
  locationName: string | null;
  source: string;
  /** Whether the Apify fallback ran because the primary found no contacts. */
  usedFallback: boolean;
  /** Businesses the venue returned, before the fashion filter. */
  storesFound: number;
  /** Of those, the fashion-relevant ones. */
  relevantStores: number;
  /** Excluded as not fashion retail (food court, bank, cinema…). */
  filteredOut: number;
  /** Relevant stores carrying a reliable Instagram link. */
  instagramFound: number;
  /** Instagram accounts already known as a boutique or earlier candidate. */
  alreadyKnown: number;
  /** Relevant stores with no reliable Instagram — kept, never guessed. */
  noInstagram: number;
  /** DiscoveryCandidates newly created by this run. */
  newCandidates: number;
}

/** Normalizes a handle the same way boutiques and candidates are stored. */
function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/**
 * Handles already present as a boutique or a discovery candidate. Mirrors the
 * Instagram discovery dedup rule exactly, so a store found via 2GIS can never
 * create a duplicate of an account we already track.
 */
async function findKnownHandles(handles: string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const lower = Array.from(new Set(handles.map(normalizeHandle)));

  const [boutiques, candidates] = await Promise.all([
    prisma.boutique.findMany({
      where: { instagramHandle: { in: lower } },
      select: { instagramHandle: true },
    }),
    prisma.discoveryCandidate.findMany({
      where: { handle: { in: lower } },
      select: { handle: true },
    }),
  ]);

  const known = new Set<string>();
  for (const boutique of boutiques) {
    if (boutique.instagramHandle) known.add(normalizeHandle(boutique.instagramHandle));
  }
  for (const candidate of candidates) known.add(normalizeHandle(candidate.handle));
  return known;
}

/** Enumerates a venue, falling back to Apify only when the primary found no contacts. */
async function enumerateStores(
  location: GisLocation,
  limit: number | undefined,
  sources: { primary: GisStoreSource; fallback: GisStoreSource | null },
): Promise<{ stores: GisStore[]; source: string; usedFallback: boolean }> {
  const stores = await sources.primary.fetchStores(location, { limit });
  const withInstagram = stores.filter((store) => store.instagramHandle).length;

  // Zero Instagram across an entire venue is the signature of an API key
  // without the paid contact_groups permission — not of a venue with no social
  // presence. That is precisely when the fallback earns its keep.
  if (withInstagram === 0 && sources.fallback && stores.length > 0) {
    logger.info("gis.fallback_engaged", {
      primary: sources.primary.name,
      fallback: sources.fallback.name,
      locationId: location.id,
      primaryStores: stores.length,
    });
    try {
      const fallbackStores = await sources.fallback.fetchStores(location, { limit });
      if (fallbackStores.some((store) => store.instagramHandle)) {
        return { stores: fallbackStores, source: sources.fallback.name, usedFallback: true };
      }
    } catch (error) {
      // A failed fallback must not lose the primary's results.
      logger.warn("gis.fallback_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { stores, source: sources.primary.name, usedFallback: false };
}

/**
 * Runs 2GIS discovery for one venue.
 *
 * `limit` caps how many businesses are enumerated — used to verify a new venue
 * cheaply before committing to a full pass. Omit it for the whole venue.
 */
export async function runGisDiscovery(
  input: string,
  options: { limit?: number; locationName?: string | null } = {},
): Promise<GisDiscoveryResult> {
  const location = parseGisLocation(input, options.locationName);
  const sources = resolveGisStoreSources();

  const { stores, source, usedFallback } = await enumerateStores(
    location,
    options.limit,
    sources,
  );

  // Only fashion retail reaches the Instagram pipeline; a mall's restaurants
  // and banks are dropped here so they never consume AI budget downstream.
  const { relevant, excluded } = partitionByRubric(stores);

  const known = await findKnownHandles(
    relevant.map((store) => store.instagramHandle).filter((h): h is string => Boolean(h)),
  );

  let instagramFound = 0;
  let alreadyKnown = 0;
  let noInstagram = 0;
  let newCandidates = 0;

  for (const store of relevant) {
    const handle = store.instagramHandle ? normalizeHandle(store.instagramHandle) : null;
    let candidateId: string | null = null;
    let status: "INSTAGRAM_FOUND" | "NO_INSTAGRAM" | "KNOWN";

    if (!handle) {
      status = "NO_INSTAGRAM";
      noInstagram += 1;
    } else if (known.has(handle)) {
      status = "KNOWN";
      instagramFound += 1;
      alreadyKnown += 1;
    } else {
      status = "INSTAGRAM_FOUND";
      instagramFound += 1;

      const sourceMeta = {
        locationId: location.id,
        locationName: location.name ?? null,
        gisId: store.gisId,
        gisUrl: store.gisUrl ?? null,
        storeName: store.name,
        address: store.address ?? null,
      } satisfies Prisma.InputJsonObject;

      // Reuses DiscoveryCandidate verbatim, so the existing Auto Import →
      // import queue → analyze → Review Queue → Telegram path is unchanged.
      const candidate = await prisma.discoveryCandidate.upsert({
        where: { handle_seedValue: { handle, seedValue: location.id } },
        update: { sourceMeta, instagramUrl: store.instagramUrl ?? "" },
        create: {
          handle,
          instagramUrl: store.instagramUrl ?? "",
          seedType: "GIS_LOCATION",
          seedValue: location.id,
          source: "2gis",
          sourceMeta,
        },
      });
      candidateId = candidate.id;
      newCandidates += 1;
      // Within one run the same account can appear twice (two outlets of one
      // brand); treat it as known from here on so it is counted once.
      known.add(handle);
    }

    // gis_id is the cross-run key: a re-run enriches rather than duplicates.
    await prisma.gisStore.upsert({
      where: { gisId: store.gisId },
      update: {
        name: store.name,
        address: store.address ?? null,
        phone: store.phone ?? null,
        website: store.website ?? null,
        rubric: store.rubric ?? null,
        latitude: store.latitude ?? null,
        longitude: store.longitude ?? null,
        locationId: location.id,
        locationName: location.name ?? null,
        gisUrl: store.gisUrl ?? null,
        source,
        status,
        instagramHandle: handle,
        instagramUrl: store.instagramUrl ?? null,
        ...(candidateId ? { candidateId } : {}),
      },
      create: {
        gisId: store.gisId,
        name: store.name,
        address: store.address ?? null,
        phone: store.phone ?? null,
        website: store.website ?? null,
        rubric: store.rubric ?? null,
        latitude: store.latitude ?? null,
        longitude: store.longitude ?? null,
        locationId: location.id,
        locationName: location.name ?? null,
        gisUrl: store.gisUrl ?? null,
        source,
        status,
        instagramHandle: handle,
        instagramUrl: store.instagramUrl ?? null,
        candidateId,
      },
    });
  }

  const result: GisDiscoveryResult = {
    locationId: location.id,
    locationKind: location.kind,
    locationName: location.name ?? null,
    source,
    usedFallback,
    storesFound: stores.length,
    relevantStores: relevant.length,
    filteredOut: excluded.length,
    instagramFound,
    alreadyKnown,
    noInstagram,
    newCandidates,
  };

  logger.info("gis.discovery.result", { ...result });
  return result;
}
