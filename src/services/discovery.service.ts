import "server-only";

import type { DiscoveryCandidate } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getDiscoveryProvider, parseDiscoverySeed } from "@/server/discovery/discovery-provider";
import { DiscoveryValidationError } from "@/server/discovery/errors";
import { addUrlsToQueue } from "@/services/import-queue.service";
import type { DiscoveryCandidateDTO, DiscoverySeedType } from "@/types";

function toDTO(row: DiscoveryCandidate): DiscoveryCandidateDTO {
  return {
    id: row.id,
    handle: row.handle,
    instagramUrl: row.instagramUrl,
    seedType: row.seedType,
    seedValue: row.seedValue,
    source: row.source,
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
  const accounts = await provider.discover(seed);

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
