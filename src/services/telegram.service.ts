import "server-only";

import { Prisma } from "@prisma/client";

import { dailyTelegramPublishLimit } from "@/config/limits";
import { sanitizeHashtags } from "@/config/telegram-hashtags";
import { startOfBusinessDay } from "@/lib/business-day";
import { categoryLabel } from "@/lib/category-engine";
import { completeHashtags } from "@/lib/hashtag-derivation";
import { allImagesExpired } from "@/lib/instagram-image";
import { ALMATY, canonicalKzCity } from "@/lib/location";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  type PublicationOutcome,
  type PublicationStatus,
  publishToTargets,
} from "@/server/publishing/publication-engine";
import type { PublishableBoutique } from "@/server/publishing/publication-target";
import { getTelegramTargets } from "@/server/publishing/telegram-target";
import { parseInstagramProfile } from "@/services/import.service";
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
  /** The failure's known cause, e.g. IMAGES_EXPIRED — a fault of this boutique, not the channel. */
  errorCode?: string | null;
  remaining: number;
  /**
   * True when the business day's publication allowance is used up. The item was
   * left untouched (still PENDING) and the caller should stop the loop — it will
   * publish on the next business day.
   */
  dailyLimitReached?: boolean;
  /** Successful publications recorded so far in the current business day. */
  publishedToday?: number;
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

/**
 * Successful publications so far in the current business day.
 *
 * Counts `telegramPublishedAt`, which is stamped ONLY when a boutique was
 * actually posted. Skipped, failed, pending and approved-but-unpublished rows
 * have it null and therefore never consume the allowance.
 */
export async function countPublishedToday(now: Date = new Date()): Promise<number> {
  return prisma.boutique.count({
    where: { telegramPublishedAt: { gte: startOfBusinessDay(now) } },
  });
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
        code: failure.code ?? null,
      }
    : Prisma.DbNull;

  await prisma.boutique.update({
    where: { id: boutiqueId },
    data: {
      telegramStatus: reduced.status,
      telegramError: failure?.error ?? null,
      telegramFailure: detail,
      // Stamped only on a real publication — this is what the daily limit counts.
      ...(reduced.status === "PUBLISHED" ? { telegramPublishedAt: new Date() } : {}),
    },
  });
}

/** The stored posts column, which Prisma hands back as untyped JSON. */
function storedPosts(posts: unknown): BoutiquePost[] {
  return Array.isArray(posts) ? (posts as unknown as BoutiquePost[]) : [];
}

/** Stored boutique → the destination-agnostic snapshot targets consume. */
function toPublishable(boutique: {
  id: string;
  name: string;
  city: string | null;
  telegramOverrideCity: string | null;
  productCategories: string[];
  hashtags: string[];
  description: string | null;
  aiResult: unknown;
  followersCount: number | null;
  bio: string | null;
  instagramUrl: string | null;
  externalUrl: string | null;
  avatarUrl: string | null;
  posts: unknown;
}): PublishableBoutique {
  const posts = storedPosts(boutique.posts);
  // Final detected categories (auto + manual corrections), highest-scoring first.
  // productCategories is stored in merge order; resolve ids → labels preserving it.
  const categories = boutique.productCategories
    .map((id) => categoryLabel(id))
    .filter((label): label is string => label !== null);

  // Published set first; fall back to what the AI recorded. Both are re-validated
  // against the whitelist on the way out — a stale or hand-edited row must never
  // reach the channel. Anything still missing is derived deterministically from
  // the categories and text this boutique already has, so a boutique analyzed
  // before hashtags existed still publishes with them and costs no model quota.
  const aiHashtags =
    boutique.aiResult && typeof boutique.aiResult === "object"
      ? (boutique.aiResult as { hashtags?: unknown }).hashtags
      : undefined;
  const stored = sanitizeHashtags(boutique.hashtags);
  const hashtags = completeHashtags(stored.length > 0 ? stored : aiHashtags, {
    categoryIds: boutique.productCategories,
    text: [boutique.bio, boutique.description, boutique.name, ...posts.map((p) => p.caption)],
  });

  return {
    id: boutique.id,
    name: boutique.name,
    city: boutique.city,
    overrideCity: boutique.telegramOverrideCity,
    categories,
    hashtags,
    followersCount: boutique.followersCount,
    bio: boutique.bio,
    instagramUrl: boutique.instagramUrl,
    externalUrl: boutique.externalUrl,
    avatarUrl: boutique.avatarUrl,
    posts,
  };
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

  const boutique = toPublishable(next);
  const targets = getTelegramTargets();

  // Daily allowance is checked ONLY for a boutique that would actually post.
  // An ineligible one publishes nothing, so it still resolves to SKIPPED today
  // rather than being held back by a limit it cannot consume.
  const willPublish = targets.some((target) => target.isEligible(boutique));
  if (willPublish) {
    const publishedToday = await countPublishedToday();
    const limit = dailyTelegramPublishLimit();
    if (publishedToday >= limit) {
      logger.info("publication.daily_limit_reached", {
        boutiqueId: next.id,
        publishedToday,
        limit,
      });
      // Left untouched: still APPROVED + PENDING, first in line tomorrow.
      return {
        processed: false,
        boutiqueId: null,
        status: null,
        error: null,
        remaining: await countPendingPublish(),
        dailyLimitReached: true,
        publishedToday,
      };
    }
  }

  const reduced = await runPublication(boutique, targets);

  return {
    processed: true,
    boutiqueId: next.id,
    status: reduced.status,
    error: reduced.failure?.error ?? null,
    errorCode: reduced.failure?.code ?? null,
    remaining: await countPendingPublish(),
    publishedToday: await countPublishedToday(),
  };
}

/** Runs the engine, logs every outcome in full, and persists the reduced result. */
async function runPublication(
  boutique: PublishableBoutique,
  targets: ReturnType<typeof getTelegramTargets>,
): Promise<{ status: PublicationStatus; failure: PublicationOutcome | null }> {
  // Target-driven: the engine runs every registered target and reports outcomes.
  const outcomes = await publishToTargets(boutique, targets);
  for (const outcome of outcomes) {
    // Log the COMPLETE diagnostics (full message + HTTP status + raw response),
    // never a shortened line, so failures are debuggable from the logs alone.
    logger.info("publication.outcome", {
      boutiqueId: boutique.id,
      target: outcome.targetId,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.httpStatus != null ? { httpStatus: outcome.httpStatus } : {}),
      ...(outcome.response ? { response: outcome.response } : {}),
    });
  }

  const reduced = reduceOutcomes(outcomes);
  await recordOutcome(boutique.id, reduced);
  return reduced;
}

/** Why a manual publish override was refused. */
export type PublishOverrideRejection =
  "NOT_FOUND" | "NOT_APPROVED" | "CITY_DETECTED" | "DAILY_LIMIT_REACHED";

export interface PublishOverrideResult {
  ok: boolean;
  rejection: PublishOverrideRejection | null;
  status: PublicationStatus | null;
  error: string | null;
  publishedToday: number;
  limit: number;
}

/**
 * Manual admin override: publish a boutique whose location could NOT be
 * detected, after a human confirmed it belongs to the channel's city.
 *
 * It records that confirmation in `telegramOverrideCity` and publishes straight
 * away. Two things it deliberately does NOT do:
 *  - it never touches the detected `city`; an Unknown boutique stays Unknown in
 *    the AI data, so detection quality stays measurable;
 *  - it never bypasses the daily publication limit — an override is a location
 *    decision, not a quota exemption.
 *
 * Only Unknown locations qualify. A boutique whose city WAS detected as some
 * other city is refused: that is a detection result to correct, not to override.
 */
export async function publishWithOverride(
  boutiqueId: string,
  overrideCity: string = ALMATY,
): Promise<PublishOverrideResult> {
  const limit = dailyTelegramPublishLimit();
  const reject = async (rejection: PublishOverrideRejection): Promise<PublishOverrideResult> => ({
    ok: false,
    rejection,
    status: null,
    error: null,
    publishedToday: await countPublishedToday(),
    limit,
  });

  const existing = await prisma.boutique.findUnique({ where: { id: boutiqueId } });
  if (!existing) return reject("NOT_FOUND");
  if (existing.status !== "APPROVED") return reject("NOT_APPROVED");
  if (canonicalKzCity(existing.city) !== null) return reject("CITY_DETECTED");

  const publishedToday = await countPublishedToday();
  if (publishedToday >= limit) {
    logger.info("publication.override_blocked_by_limit", { boutiqueId, publishedToday, limit });
    return reject("DAILY_LIMIT_REACHED");
  }

  // Persist the admin's confirmation first, so the record explains the post even
  // if publishing then fails — and so a retry stays eligible without re-asking.
  const updated = await prisma.boutique.update({
    where: { id: boutiqueId },
    data: { telegramOverrideCity: overrideCity },
  });
  logger.info("publication.override_applied", {
    boutiqueId,
    detectedCity: updated.city,
    overrideCity,
  });

  const reduced = await runPublication(toPublishable(updated), getTelegramTargets());

  return {
    ok: reduced.status === "PUBLISHED",
    rejection: null,
    status: reduced.status,
    error: reduced.failure?.error ?? null,
    publishedToday: await countPublishedToday(),
    limit,
  };
}

/** Why requeueing a publication was refused. */
export type RetryPublicationRejection =
  | "NOT_FOUND"
  | "NOT_APPROVED"
  | "NOT_FAILED"
  /** Skipped, and still not in the channel's city: that decision stands. */
  | "NOT_ALMATY"
  /** Every image link has expired; requeueing would fail the same way. Re-parse instead. */
  | "IMAGES_EXPIRED";

export interface RetryPublicationResult {
  ok: boolean;
  rejection: RetryPublicationRejection | null;
}

/**
 * Puts a FAILED publication — or a stale SKIPPED one — back in the pending
 * column so Publish Queue can try it again.
 *
 * Until this existed a failed publication was final: nothing in the app moved a
 * boutique out of FAILED, so an outage, a missing token or a transient Telegram
 * error stranded it there for good and the only way back was an UPDATE against
 * the database. Failures here are routinely temporary — the channel was
 * unreachable, the bot was not configured yet — so they need an ordinary way
 * back into the queue.
 *
 * It only REQUEUES. Publishing stays with Publish Queue, which is where the
 * daily limit and the channel's pacing are enforced; retrying does not post
 * anything by itself and cannot be used to slip past either.
 */
export async function retryFailedPublication(boutiqueId: string): Promise<RetryPublicationResult> {
  const existing = await prisma.boutique.findUnique({ where: { id: boutiqueId } });
  if (!existing) return { ok: false, rejection: "NOT_FOUND" };
  if (existing.status !== "APPROVED") return { ok: false, rejection: "NOT_APPROVED" };
  /**
   * A SKIPPED boutique comes back only when the skip has gone stale.
   *
   * The publisher skips a boutique whose city it cannot place, and for a long
   * time the city column was empty for almost everything — so Almaty stores
   * were skipped for want of data, not for being elsewhere. Once their city was
   * filled in they sat in SKIPPED with nothing able to move them: Publish Queue
   * takes only PENDING, "Publish anyway" appears only while the city is
   * unknown, and this function took only FAILED. A skip whose city is now
   * Almaty, on a boutique never published, is such a stale one. A boutique
   * skipped because it really is in another city stays skipped.
   */
  if (existing.telegramStatus === "SKIPPED") {
    const staleSkip = canonicalKzCity(existing.city) === ALMATY && !existing.telegramPublishedAt;
    if (!staleSkip) return { ok: false, rejection: "NOT_ALMATY" };
  } else if (existing.telegramStatus !== "FAILED") {
    // PUBLISHED must never be re-sent to subscribers from here; PENDING is
    // already where this would put it.
    return { ok: false, rejection: "NOT_FAILED" };
  }

  // Requeueing a FAILED post sends the same stored links. Once all of them have
  // expired that can only fail again — six boutiques were retried into exactly
  // that, and their failures stopped the run before the live ones behind them
  // were sent. A stale SKIP is still requeued: there is no Re-parse on the
  // Skipped column, and the failure it meets lands it in FAILED, where there is.
  if (
    existing.telegramStatus === "FAILED" &&
    allImagesExpired(existing.avatarUrl, storedPosts(existing.posts))
  ) {
    return { ok: false, rejection: "IMAGES_EXPIRED" };
  }

  await prisma.boutique.update({
    where: { id: boutiqueId },
    data: {
      telegramStatus: "PENDING",
      telegramError: null,
      telegramFailure: Prisma.DbNull,
    },
  });
  logger.info("publication.retry_requeued", {
    boutiqueId,
    from: existing.telegramStatus,
    previousError: existing.telegramError,
  });

  return { ok: true, rejection: null };
}

/** Why refreshing a failed publication's images was refused. */
export type RefreshImagesRejection =
  | "NOT_FOUND"
  | "NOT_APPROVED"
  | "NOT_FAILED"
  | "NO_INSTAGRAM"
  /** The scrape landed on a different boutique — the profile was renamed or moved. */
  | "DIFFERENT_PROFILE"
  /** Scraped again, and there is still no live image to send. */
  | "STILL_EXPIRED";

export interface RefreshImagesResult {
  ok: boolean;
  rejection: RefreshImagesRejection | null;
}

/**
 * Re-parses a boutique whose publication failed, to replace its image links,
 * then puts it back in the pending column.
 *
 * Stored Instagram links die a few days after the scrape, and Retry sends the
 * same ones again; only a fresh scrape brings live links. The parse keeps what
 * the boutique already has — its approval, city and AI categories — and
 * refreshes the profile fields, the images among them.
 *
 * It costs one Apify run, and, like Retry, it only REQUEUES: Publish Queue
 * still does the posting, under the daily limit.
 */
export async function refreshPublicationImages(boutiqueId: string): Promise<RefreshImagesResult> {
  const existing = await prisma.boutique.findUnique({ where: { id: boutiqueId } });
  if (!existing) return { ok: false, rejection: "NOT_FOUND" };
  if (existing.status !== "APPROVED") return { ok: false, rejection: "NOT_APPROVED" };
  if (existing.telegramStatus !== "FAILED") return { ok: false, rejection: "NOT_FAILED" };
  if (!existing.instagramUrl) return { ok: false, rejection: "NO_INSTAGRAM" };

  // Throws when the scrape itself fails; the caller reports that as it is.
  const { boutiqueId: parsedId } = await parseInstagramProfile({ url: existing.instagramUrl });
  if (parsedId !== boutiqueId) {
    logger.warn("publication.refresh_different_profile", { boutiqueId, parsedId });
    return { ok: false, rejection: "DIFFERENT_PROFILE" };
  }

  const refreshed = await prisma.boutique.findUnique({ where: { id: boutiqueId } });
  if (!refreshed || allImagesExpired(refreshed.avatarUrl, storedPosts(refreshed.posts))) {
    return { ok: false, rejection: "STILL_EXPIRED" };
  }

  await prisma.boutique.update({
    where: { id: boutiqueId },
    data: {
      telegramStatus: "PENDING",
      telegramError: null,
      telegramFailure: Prisma.DbNull,
    },
  });
  logger.info("publication.images_refreshed", {
    boutiqueId,
    previousError: existing.telegramError,
  });

  return { ok: true, rejection: null };
}
