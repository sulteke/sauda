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
  /** Instagram accounts already known from ELSEWHERE (a boutique, or a
   *  candidate found via another seed). These get no new candidate. */
  alreadyKnown: number;
  /** Candidates this venue had already produced on an earlier run (re-linked,
   *  never duplicated). */
  existingCandidates: number;
  /** Relevant stores with no reliable Instagram — kept, never guessed. */
  noInstagram: number;
  /** DiscoveryCandidates newly created by this run. */
  newCandidates: number;
}

/** Normalizes a handle the same way boutiques and candidates are stored. */
function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

interface KnownHandles {
  /**
   * Handles known from ELSEWHERE — an imported boutique, or a candidate found
   * through a different seed (a hashtag, another venue). These must not get a
   * second candidate.
   */
  foreign: Set<string>;
  /**
   * Candidates THIS venue already produced on an earlier run, by handle.
   *
   * Keeping these separate is what makes a re-run idempotent without lying: the
   * store still resolved its own Instagram here, so it stays INSTAGRAM_FOUND
   * and re-links to the same candidate. Folding them in with `foreign` (the
   * original bug) relabelled every store KNOWN on the second run and erased
   * which stores this venue had actually produced.
   */
  own: Map<string, string>;
}

/**
 * Splits the handles this run found into "already known elsewhere" and
 * "already ours from a previous run of this same venue".
 */
async function findKnownHandles(handles: string[], locationId: string): Promise<KnownHandles> {
  const empty: KnownHandles = { foreign: new Set(), own: new Map() };
  if (handles.length === 0) return empty;
  const lower = Array.from(new Set(handles.map(normalizeHandle)));

  const [boutiques, candidates] = await Promise.all([
    prisma.boutique.findMany({
      where: { instagramHandle: { in: lower } },
      select: { instagramHandle: true },
    }),
    prisma.discoveryCandidate.findMany({
      where: { handle: { in: lower } },
      select: { id: true, handle: true, seedValue: true, seedType: true },
    }),
  ]);

  const foreign = new Set<string>();
  const own = new Map<string, string>();
  for (const boutique of boutiques) {
    if (boutique.instagramHandle) foreign.add(normalizeHandle(boutique.instagramHandle));
  }
  for (const candidate of candidates) {
    const handle = normalizeHandle(candidate.handle);
    if (candidate.seedType === "GIS_LOCATION" && candidate.seedValue === locationId) {
      own.set(handle, candidate.id);
    } else {
      foreign.add(handle);
    }
  }
  // A boutique always wins: if the account is already imported, this venue's
  // old candidate is history, not a reason to claim it again.
  for (const handle of foreign) own.delete(handle);

  return { foreign, own };
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
    location.id,
  );

  let instagramFound = 0;
  let alreadyKnown = 0;
  let noInstagram = 0;
  let newCandidates = 0;
  let existingCandidates = 0;

  for (const store of relevant) {
    const handle = store.instagramHandle ? normalizeHandle(store.instagramHandle) : null;
    let candidateId: string | null = null;
    let status: "INSTAGRAM_FOUND" | "NO_INSTAGRAM" | "KNOWN";

    if (!handle) {
      status = "NO_INSTAGRAM";
      noInstagram += 1;
    } else if (known.foreign.has(handle)) {
      // Known from a boutique or another seed — this venue does not claim it.
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

      const existingId = known.own.get(handle);
      // Reuses DiscoveryCandidate verbatim, so the existing Auto Import →
      // import queue → analyze → Review Queue → Telegram path is unchanged.
      // The unique (handle, seedValue) key makes this idempotent: a re-run
      // refreshes the same row instead of creating a second one.
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

      if (existingId) existingCandidates += 1;
      else newCandidates += 1;

      // Within one run the same account can appear twice (two outlets of one
      // brand). Record it as ours so the second storefront re-links to the same
      // candidate and is counted as existing, not as a new one.
      known.own.set(handle, candidate.id);
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
    existingCandidates,
    noInstagram,
    newCandidates,
  };

  logger.info("gis.discovery.result", { ...result });
  return result;
}
