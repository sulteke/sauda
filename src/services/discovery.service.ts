import "server-only";

import type { DiscoveryCandidate } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_TARGET_NEW_ACCOUNTS,
  getDiscoveryProvider,
  parseDiscoverySeed,
} from "@/server/discovery/discovery-provider";
import { DiscoveryValidationError } from "@/server/discovery/errors";
import { addUrlsToQueue } from "@/services/import-queue.service";
import type { DiscoveryCandidateDTO, DiscoverySeedType } from "@/types";

/**
 * Returns the subset of the given handles that already exist in the database —
 * either as an imported boutique or as a previously-discovered candidate — so
 * discovery can skip them and keep only genuinely-new accounts. Handles are
 * compared lowercased (the normalized form stored for both).
 */
async function findKnownHandles(handles: string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const lower = Array.from(new Set(handles.map((handle) => handle.toLowerCase())));

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
    if (boutique.instagramHandle) known.add(boutique.instagramHandle.toLowerCase());
  }
  for (const candidate of candidates) known.add(candidate.handle.toLowerCase());
  return known;
}

/**
 * How many NEW unique accounts one discovery run aims to collect. Configurable
 * via APIFY_DISCOVERY_TARGET_NEW_ACCOUNTS (default 50); a non-positive/invalid
 * value falls back to the default.
 */
function resolveTargetNewAccounts(): number {
  const env = Number(process.env.APIFY_DISCOVERY_TARGET_NEW_ACCOUNTS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TARGET_NEW_ACCOUNTS;
}

function toDTO(row: DiscoveryCandidate): DiscoveryCandidateDTO {
  return {
    id: row.id,
    handle: row.handle,
    instagramUrl: row.instagramUrl,
    seedType: row.seedType,
    seedValue: row.seedValue,
    source: row.source,
    sourceMeta: (row.sourceMeta as Record<string, unknown> | null) ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DiscoveryRunResult {
  seedType: DiscoverySeedType;
  seedValue: string;
  found: number;
  added: number;
}

/**
 * Runs discovery for a seed (profile or hashtag) and stores NEW candidates.
 * Does NOT import anything — candidates wait for admin review.
 */
export async function runDiscovery(input: string): Promise<DiscoveryRunResult> {
  const seed = parseDiscoverySeed(input);
  if (!seed) {
    throw new DiscoveryValidationError(
      "Enter an Instagram profile (@handle or URL) or a #hashtag.",
    );
  }

  const provider = getDiscoveryProvider();
  const targetNewCount = resolveTargetNewAccounts();
  // TEMP DIAGNOSTIC: shows which provider ran and the seed — if this logs
  // provider "mock", discovery never hits Apify/pagination at all.
  logger.info("discovery.run", {
    provider: provider.name,
    seedType: seed.type,
    seedValue: seed.value,
    targetNew: targetNewCount,
  });
  // Collect genuinely-new accounts (skipping any handle already imported or
  // previously discovered) until we reach the target or the dataset is exhausted.
  const accounts = await provider.discover(seed, {
    isKnownHandles: findKnownHandles,
    targetNewCount,
  });

  // TEMP DIAGNOSTIC: how many NEW accounts the provider returned for this run.
  logger.info("discovery.run.result", {
    provider: provider.name,
    seedValue: seed.value,
    returnedAccounts: accounts.length,
  });

  const created =
    accounts.length > 0
      ? await prisma.discoveryCandidate.createMany({
          data: accounts.map((account) => ({
            handle: account.handle,
            instagramUrl: account.instagramUrl,
            seedType: seed.type,
            seedValue: seed.value,
            source: provider.name,
          })),
          skipDuplicates: true,
        })
      : { count: 0 };

  return {
    seedType: seed.type,
    seedValue: seed.value,
    found: accounts.length,
    added: created.count,
  };
}

/** Lists candidates awaiting review. */
export async function listCandidates(): Promise<DiscoveryCandidateDTO[]> {
  try {
    const rows = await prisma.discoveryCandidate.findMany({
      where: { status: "NEW" },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDTO);
  } catch (error) {
    console.error("Failed to list discovery candidates:", error);
    return [];
  }
}

/** Sends selected candidates into the EXISTING import queue and marks them QUEUED. */
export async function queueCandidates(ids: string[]): Promise<{ queued: number }> {
  if (ids.length === 0) return { queued: 0 };

  const rows = await prisma.discoveryCandidate.findMany({
    where: { id: { in: ids }, status: "NEW" },
  });
  if (rows.length === 0) return { queued: 0 };

  // Reuse the import queue verbatim — no import logic is duplicated here.
  await addUrlsToQueue(rows.map((row) => row.instagramUrl).join("\n"));

  await prisma.discoveryCandidate.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { status: "QUEUED" },
  });

  return { queued: rows.length };
}

/** Dismisses selected candidates so they leave the review list. */
export async function dismissCandidates(ids: string[]): Promise<{ dismissed: number }> {
  if (ids.length === 0) return { dismissed: 0 };

  const result = await prisma.discoveryCandidate.updateMany({
    where: { id: { in: ids }, status: "NEW" },
    data: { status: "DISMISSED" },
  });

  return { dismissed: result.count };
}
