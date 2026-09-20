import "server-only";

import { deriveHashtags } from "@/lib/hashtag-derivation";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Deterministic hashtag backfill for boutiques analyzed before hashtags existed.
 *
 * It deliberately calls NO model. Re-analyzing these boutiques through Gemini
 * would burn the daily allowance on data we already hold: their categories,
 * bio/description and post captions are stored, and that is exactly the
 * evidence a hashtag needs. Re-running the AI would also be non-reproducible,
 * whereas this pass yields the same tags every time and can be reviewed as data.
 *
 * It touches ONLY `hashtags`. Categories, AI results, approval status and
 * Telegram state are left exactly as they are — including for already-published
 * boutiques, which simply start carrying hashtags on their next publish.
 */

export interface HashtagBackfillResult {
  /** Boutiques examined (those with no usable hashtags yet). */
  candidates: number;
  /** Boutiques that gained at least one hashtag. */
  updated: number;
  /** Boutiques left empty because the stored data supported no tag. */
  skipped: number;
  /** Per-boutique outcome, for review before/after a run. */
  details: { id: string; name: string; hashtags: string[] }[];
}

/**
 * Fills `hashtags` for every boutique that has none.
 *
 * Idempotent: a boutique that already has hashtags is never touched, so the
 * pass can be re-run safely. `dryRun` reports exactly what would change without
 * writing anything — use it to review a production run first.
 */
export async function backfillBoutiqueHashtags(
  options: { dryRun?: boolean } = {},
): Promise<HashtagBackfillResult> {
  const dryRun = options.dryRun ?? false;

  const rows = await prisma.boutique.findMany({
    where: { hashtags: { isEmpty: true } },
    select: {
      id: true,
      name: true,
      bio: true,
      description: true,
      productCategories: true,
      posts: true,
    },
  });

  const details: HashtagBackfillResult["details"] = [];
  let updated = 0;

  for (const row of rows) {
    const posts = Array.isArray(row.posts) ? (row.posts as { caption?: unknown }[]) : [];
    const hashtags = deriveHashtags({
      categoryIds: row.productCategories,
      text: [
        row.bio,
        row.description,
        row.name,
        ...posts.map((post) => (typeof post?.caption === "string" ? post.caption : null)),
      ],
    });

    details.push({ id: row.id, name: row.name, hashtags });
    if (hashtags.length === 0) continue;

    if (!dryRun) {
      await prisma.boutique.update({ where: { id: row.id }, data: { hashtags } });
    }
    updated += 1;
  }

  const result: HashtagBackfillResult = {
    candidates: rows.length,
    updated,
    skipped: rows.length - updated,
    details,
  };

  logger.info("hashtags.backfill", {
    dryRun,
    candidates: result.candidates,
    updated: result.updated,
    skipped: result.skipped,
  });

  return result;
}
