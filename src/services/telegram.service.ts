import "server-only";

import { Prisma } from "@prisma/client";

import { categoryLabel } from "@/lib/category-engine";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  type PublicationOutcome,
  type PublicationStatus,
  publishToTargets,
} from "@/server/publishing/publication-engine";
import type { PublishableBoutique } from "@/server/publishing/publication-target";
import { getTelegramTargets } from "@/server/publishing/telegram-target";
import type { BoutiquePost } from "@/types";

// Re-exported for backward compatibility — the Telegram-specific formatting now
// lives with the Telegram publication target.
export { buildCaption, toHashtag } from "@/server/publishing/telegram-target";
export type { PublishableBoutique } from "@/server/publishing/publication-target";

export interface TelegramProcessResult {
  processed: boolean;
  boutiqueId: string | null;
  status: "PUBLISHED" | "SKIPPED" | "FAILED" | null;
  error: string | null;
  remaining: number;
}

// ---------------------------------------------------------------------------
// Storage COMPAT boundary.
//
// The engine and targets are fully generic; the ONLY Telegram-specific storage
// assumption left is that we collapse per-target outcomes into the single
// `telegramStatus` column. Everything that ties publication to that column lives
// in this section. When a generic per-target publications table is introduced,
// replace just these helpers (selection, count, reduce, record) with reads/
// writes against that table — the engine, targets, and driver stay unchanged.
// ---------------------------------------------------------------------------

/** Approved boutiques still awaiting a publishing decision (telegramStatus=PENDING). */
async function countPendingPublish(): Promise<number> {
  return prisma.boutique.count({ where: { status: "APPROVED", telegramStatus: "PENDING" } });
}

/** Collapses per-target outcomes into the single status we persist today. */
function reduceOutcomes(outcomes: PublicationOutcome[]): {
  status: PublicationStatus;
  failure: PublicationOutcome | null;
} {
  const failure = outcomes.find((outcome) => outcome.status === "FAILED") ?? null;
  if (failure) return { status: "FAILED", failure };
  const published = outcomes.some((outcome) => outcome.status === "PUBLISHED");
  return { status: published ? "PUBLISHED" : "SKIPPED", failure: null };
}

/**
 * Persists the reduced outcome onto the boutique (never touches approval
 * `status`). On failure it stores the COMPLETE message in `telegramError` plus
 * the structured detail (target, HTTP status, full response, timestamp) in
 * `telegramFailure` for the UI; on success/skip it clears both.
 */
async function recordOutcome(
  boutiqueId: string,
  reduced: { status: PublicationStatus; failure: PublicationOutcome | null },
): Promise<void> {
  const failure = reduced.failure;
  const detail: Prisma.InputJsonValue | typeof Prisma.DbNull = failure
    ? {
        targetId: failure.targetId,
        targetLabel: failure.label,
        httpStatus: failure.httpStatus ?? null,
        message: failure.error ?? "",
        response: failure.response ?? null,
        failedAt: new Date().toISOString(),
      }
    : Prisma.DbNull;

  await prisma.boutique.update({
    where: { id: boutiqueId },
    data: {
      telegramStatus: reduced.status,
      telegramError: failure?.error ?? null,
      telegramFailure: detail,
    },
  });
}

// ---------------------------------------------------------------------------

/**
 * Publication driver — a step fully INDEPENDENT of approval. It picks the oldest
 * APPROVED boutique still awaiting publication, runs it through the target-driven
 * {@link publishToTargets} engine, and records the result. The driver itself
 * contains NO destination logic: which targets exist, whether a boutique is
 * eligible, and how to publish all live behind the PublicationTarget seam. Today
 * the only registered target is the Almaty Telegram channel, so this reduces to
 * the existing behaviour (Almaty → PUBLISHED, other cities → SKIPPED, publish
 * error → FAILED). Uses ONLY stored data (no re-scrape) and never throws.
 *
 * Adding channels, cities, or entirely new targets (Website, Instagram,
 * WhatsApp, Email) means registering a target — not editing this driver, the
 * approval workflow, or the import pipeline.
 */
export async function processNextTelegramPost(): Promise<TelegramProcessResult> {
  const next = await prisma.boutique.findFirst({
    where: { status: "APPROVED", telegramStatus: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!next) {
    return { processed: false, boutiqueId: null, status: null, error: null, remaining: 0 };
  }

  const posts = Array.isArray(next.posts) ? (next.posts as unknown as BoutiquePost[]) : [];
  // Final detected categories (auto + manual corrections), highest-scoring first.
  // productCategories is stored in merge order; resolve ids → labels preserving it.
  const categories = next.productCategories
    .map((id) => categoryLabel(id))
    .filter((label): label is string => label !== null);

  const boutique: PublishableBoutique = {
    id: next.id,
    name: next.name,
    city: next.city,
    categories,
    followersCount: next.followersCount,
    bio: next.bio,
    instagramUrl: next.instagramUrl,
    externalUrl: next.externalUrl,
    avatarUrl: next.avatarUrl,
    posts,
  };

  // Target-driven: the engine runs every registered target and reports outcomes.
  const outcomes = await publishToTargets(boutique, getTelegramTargets());
  for (const outcome of outcomes) {
    // Log the COMPLETE diagnostics (full message + HTTP status + raw response),
    // never a shortened line, so failures are debuggable from the logs alone.
    logger.info("publication.outcome", {
      boutiqueId: next.id,
      target: outcome.targetId,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.httpStatus != null ? { httpStatus: outcome.httpStatus } : {}),
      ...(outcome.response ? { response: outcome.response } : {}),
    });
  }

  const reduced = reduceOutcomes(outcomes);
  await recordOutcome(next.id, reduced);

  return {
    processed: true,
    boutiqueId: next.id,
    status: reduced.status,
    error: reduced.failure?.error ?? null,
    remaining: await countPendingPublish(),
  };
}
