import "server-only";

import type { ImportQueue } from "@prisma/client";

import { analysisBatchSize, minFollowersForAnalysis } from "@/config/limits";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { countAnalysesToday } from "@/server/ai/analysis-budget";
import { AiCategoryProviderError } from "@/lib/ai-category-provider";
import { analyzeBatchWithPool, anyProviderAvailable } from "@/server/ai/ai-provider-pool";
import {
  applyAnalysisResult,
  markAnalysisJobFailed,
  type PreparedAnalysisJob,
  prepareAnalysisJob,
} from "@/server/import/import-pipeline";
import { parseInstagramHandle } from "@/server/import/instagram-url";
import { parseInstagramProfile } from "@/services/import.service";
import type { ImportQueueItemDTO } from "@/types";

function toDTO(row: ImportQueue): ImportQueueItemDTO {
  return {
    id: row.id,
    instagramUrl: row.instagramUrl,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Boutiques already imported for these handles, as a LOWERCASE set.
 *
 * Instagram treats handles case-insensitively — @Qoima and @qoima are one
 * account — but `Boutique.instagramHandle` is a plain unique column, so a
 * case-sensitive lookup would happily let the same shop in twice. Every
 * comparison here therefore goes through lower case, and the query itself asks
 * Postgres for an insensitive match rather than trusting how the handle
 * happened to be stored.
 */
async function existingBoutiqueHandles(handles: readonly string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const rows = await prisma.boutique.findMany({
    // One OR per handle, each insensitive — `in` does not honour `mode`.
    where: { OR: handles.map((handle) => ({ instagramHandle: { equals: handle, mode: "insensitive" as const } })) },
    select: { instagramHandle: true },
  });
  return new Set(
    rows
      .map((row) => row.instagramHandle?.toLowerCase())
      .filter((handle): handle is string => Boolean(handle)),
  );
}

/**
 * Whether this Instagram handle already has a boutique — ANY status counts.
 *
 * APPROVED, REJECTED and DRAFT all mean the same thing here: the profile has
 * been through the pipeline once and a decision about it already exists.
 * Scraping and analyzing it again would spend Apify and Gemini to re-learn
 * something the database already knows.
 */
async function boutiqueExistsForHandle(handle: string): Promise<boolean> {
  const existing = await prisma.boutique.findFirst({
    where: { instagramHandle: { equals: handle, mode: "insensitive" } },
    select: { id: true },
  });
  return existing !== null;
}

/** Parses pasted text (one URL per line) and queues the valid Instagram URLs. */
export async function addUrlsToQueue(
  text: string,
): Promise<{ added: number; skipped: number; duplicates: number }> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const unique = Array.from(new Set(lines));
  const parsed = unique
    .map((url) => ({ url, handle: parseInstagramHandle(url) }))
    .filter((entry): entry is { url: string; handle: string } => entry.handle !== null);
  const skipped = unique.length - parsed.length;

  // Keep already-imported profiles out of the queue entirely, so the run is not
  // padded with work that would only be skipped later.
  const alreadyImported = await existingBoutiqueHandles(parsed.map((entry) => entry.handle));
  const fresh = parsed.filter((entry) => !alreadyImported.has(entry.handle.toLowerCase()));
  const duplicates = parsed.length - fresh.length;

  if (fresh.length > 0) {
    await prisma.importQueue.createMany({
      data: fresh.map((entry) => ({ instagramUrl: entry.url })),
    });
  }

  logger.info("queue.urls_added", { added: fresh.length, skipped, duplicates });
  return { added: fresh.length, skipped, duplicates };
}

export async function listQueue(): Promise<ImportQueueItemDTO[]> {
  try {
    const rows = await prisma.importQueue.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(toDTO);
  } catch (error) {
    console.error("Failed to list import queue:", error);
    return [];
  }
}

/**
 * Permanently deletes a single queue row (any status — a PROCESSING row can be
 * removed too). Idempotent: deleting a missing row just returns { deleted: 0 }.
 */
export async function deleteQueueItem(id: string): Promise<{ deleted: number }> {
  const { count } = await prisma.importQueue.deleteMany({ where: { id } });
  return { deleted: count };
}

/** Statuses that represent a fully-imported boutique (new + legacy). */
const SUCCESS_STATUSES = ["READY_FOR_REVIEW", "COMPLETED"] as const;
/**
 * Stage-scoped + legacy failure statuses. The SKIPPED_* statuses are
 * deliberately NOT here: they are decisions, not failures, so "Clear Failed"
 * leaves them alone and the retry path refuses them.
 */
const FAILED_STATUSES = ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"] as const;
/** Statuses with work still to do (not yet complete, not failed). */
const ACTIONABLE_STATUSES = [
  "PENDING_PARSE",
  "PARSING",
  "PENDING_ANALYSIS",
  "ANALYZING",
] as const;

/** What a bulk clear targets. "ALL" removes every row regardless of status. */
export type ClearQueueScope = "COMPLETED" | "FAILED" | "ALL";

/** Permanently deletes queue rows matching the scope. Returns how many were removed. */
export async function clearQueue(scope: ClearQueueScope): Promise<{ deleted: number }> {
  const where =
    scope === "ALL"
      ? {}
      : scope === "COMPLETED"
        ? { status: { in: [...SUCCESS_STATUSES] } }
        : { status: { in: [...FAILED_STATUSES] } };
  const { count } = await prisma.importQueue.deleteMany({ where });
  return { deleted: count };
}

export interface ProcessResult {
  processed: boolean;
  /** The first item this call settled — kept so single-item callers still work. */
  item: ImportQueueItemDTO | null;
  /**
   * Every item this call settled. The Analyze stage now advances a whole batch
   * in one model request, so one call can finish several items; `item` alone
   * would under-report the run.
   */
  items?: ImportQueueItemDTO[];
  remaining: number;
  /**
   * True when the business day's AI allowance is genuinely used up. The item was
   * left in PENDING_ANALYSIS, so the caller should stop the loop; the work
   * resumes untouched on the next business day.
   */
  dailyLimitReached?: boolean;
  /**
   * Set instead of `dailyLimitReached` when the block is TEMPORARY: every
   * project still has daily budget left, but each is cooling down after a 503
   * or a rate-limit blip. The value is when the first one becomes usable again,
   * so the caller can wait and carry on rather than abandoning the run — a busy
   * minute at Google should not end an import that has budget to spend.
   */
  retryAfter?: string;
  /** AI calls issued so far in the current business day. */
  analyzedToday?: number;
}

/** A job stuck mid-stage longer than this is treated as dead and re-queued. */
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

/** In-flight states and the pending state each reverts to on stale recovery. */
const IN_FLIGHT_RECOVERY = [
  { from: "PARSING", to: "PENDING_PARSE", stage: "parse" },
  { from: "ANALYZING", to: "PENDING_ANALYSIS", stage: "analyze" },
] as const;

/**
 * Recovers jobs orphaned mid-stage (e.g. the serverless function was killed by a
 * Vercel timeout before it could land a terminal status). Any PARSING/ANALYZING
 * job whose last update is older than STALE_PROCESSING_MS reverts to its pending
 * state (PENDING_PARSE / PENDING_ANALYSIS) so that stage is retried — a stuck
 * ANALYZING job reverts to PENDING_ANALYSIS, so it re-runs Gemini only and never
 * re-scrapes. No real stage runs longer than the function limit, so the
 * threshold never touches a genuinely in-flight job.
 */
export async function requeueStaleJobs(): Promise<number> {
  const threshold = new Date(Date.now() - STALE_PROCESSING_MS);
  let total = 0;

  for (const { from, to, stage } of IN_FLIGHT_RECOVERY) {
    const where = { status: from, updatedAt: { lt: threshold } };
    const stale = await prisma.importQueue.findMany({
      where,
      select: { id: true, instagramUrl: true, updatedAt: true },
    });
    if (stale.length === 0) continue;

    logger.warn("queue.stale_job_detected", {
      stage,
      count: stale.length,
      thresholdMinutes: STALE_PROCESSING_MS / 60_000,
      jobs: stale.map((job) => ({
        id: job.id,
        instagramUrl: job.instagramUrl,
        stuckForMs: Date.now() - job.updatedAt.getTime(),
      })),
    });

    const { count } = await prisma.importQueue.updateMany({ where, data: { status: to } });
    logger.info("queue.job_requeued", { stage, count, ids: stale.map((job) => job.id) });
    total += count;
  }

  return total;
}

/**
 * Re-queues a failed item for its OWN stage, so retries are independent:
 *   PARSE_FAILED    → PENDING_PARSE     (re-scrapes via Apify)
 *   ANALYSIS_FAILED → PENDING_ANALYSIS  (re-runs Gemini only — never re-scrapes)
 *   FAILED (legacy) → PENDING_PARSE     (restart from scratch)
 * Throws if the item is missing or not in a retryable state.
 */
export async function retryQueueItem(id: string): Promise<ImportQueueItemDTO> {
  const row = await prisma.importQueue.findUnique({ where: { id } });
  if (!row) {
    throw new Error("Queue item not found.");
  }

  const target =
    row.status === "PARSE_FAILED"
      ? "PENDING_PARSE"
      : row.status === "ANALYSIS_FAILED"
        ? "PENDING_ANALYSIS"
        : row.status === "FAILED"
          ? "PENDING_PARSE"
          : null;

  if (!target) {
    throw new Error(`Cannot retry a queue item in status ${row.status}.`);
  }

  const updated = await prisma.importQueue.update({
    where: { id },
    data: { status: target, error: null },
  });
  logger.info("queue.retry", { id, from: row.status, to: target });
  return toDTO(updated);
}

/**
 * Advances the queue by exactly ONE stage of ONE item, so no single invocation
 * combines the slow Apify scrape (Parse) with the Gemini analysis (Analyze) —
 * each call stays well under the serverless function limit. The browser driver
 * calls this repeatedly while `remaining > 0`.
 *
 * Priority: finish analysis before starting new parses, so boutiques reach
 * READY_FOR_REVIEW one at a time rather than leaving many half-done. Stale
 * in-flight jobs are recovered first. A successful Parse hands straight off to
 * PENDING_ANALYSIS, so there is no intermediate resting state to promote.
 */
export async function processNextImport(): Promise<ProcessResult> {
  await requeueStaleJobs();

  // Stage 2 first — drain analysis, a batch at a time so one model request
  // covers several shops.
  const analyzeRows = await prisma.importQueue.findMany({
    where: { status: "PENDING_ANALYSIS" },
    orderBy: { createdAt: "asc" },
    take: analysisBatchSize(),
    select: { id: true, instagramUrl: true, importJobId: true },
  });
  if (analyzeRows.length > 0) return runAnalyzeBatchStage(analyzeRows);

  // Stage 1 — start the next parse, unless today's AI allowance is already gone.
  // Scraping more profiles now would only pile up work that cannot be analyzed
  // until tomorrow, so it is bounded here rather than after the Apify spend.
  const parseRow = await prisma.importQueue.findFirst({
    where: { status: "PENDING_PARSE" },
    orderBy: { createdAt: "asc" },
  });
  if (parseRow) {
    const budget = await analysisBudgetSnapshot();
    if (budget.reached) {
      const remaining = await countRemaining();
      const temporary = budget.retryAfter !== null;
      logger.info(temporary ? "queue.cooling_down" : "queue.daily_limit_reached", {
        id: parseRow.id,
        instagramUrl: parseRow.instagramUrl,
        stage: "parse",
        analyzedToday: budget.used,
        limit: budget.limit,
        remaining,
        retryAfter: budget.retryAfter?.toISOString() ?? null,
      });
      return {
        processed: false,
        item: null,
        remaining,
        ...(temporary ? { retryAfter: budget.retryAfter!.toISOString() } : { dailyLimitReached: true }),
        analyzedToday: budget.used,
      };
    }
    return runParseStage(parseRow.id, parseRow.instagramUrl);
  }

  logger.info("queue.finished", { reason: "no-actionable-jobs" });
  return { processed: false, item: null, remaining: 0 };
}

/**
 * Parse stage: Apify fetch + keyword-only persist. On success hands straight off
 * to the analysis stage. PARSING → PENDING_ANALYSIS / PARSE_FAILED.
 */
async function runParseStage(id: string, instagramUrl: string): Promise<ProcessResult> {
  logger.info("queue.parse_selected", { id, instagramUrl });

  // Second duplicate check, and the one that actually guards the spend: a
  // boutique may have appeared between queueing and now (another run, a manual
  // import), and the add-time filter cannot know about that. Checked BEFORE the
  // PARSING transition so a duplicate costs no Apify call and no Gemini call.
  const handle = parseInstagramHandle(instagramUrl);
  if (handle && (await boutiqueExistsForHandle(handle))) {
    const message = `Skipped: @${handle} is already imported.`;
    const updated = await prisma.importQueue.update({
      where: { id },
      data: { status: "SKIPPED_DUPLICATE", error: message },
    });
    const remaining = await countRemaining();
    logger.info("queue.parse_skipped", {
      id,
      instagramUrl,
      handle,
      status: "SKIPPED_DUPLICATE",
      remaining,
    });
    return { processed: true, item: toDTO(updated), remaining };
  }

  await prisma.importQueue.update({ where: { id }, data: { status: "PARSING" } });
  const startedAt = Date.now();

  try {
    const { job } = await parseInstagramProfile({ url: instagramUrl, userId: null });
    const updated = await prisma.importQueue.update({
      where: { id },
      data: { status: "PENDING_ANALYSIS", importJobId: job.id, error: null },
    });
    const remaining = await countRemaining();
    logger.info("queue.parse_finished", {
      id,
      status: "PENDING_ANALYSIS",
      durationMs: Date.now() - startedAt,
      remaining,
    });
    return { processed: true, item: toDTO(updated), items: [toDTO(updated)], remaining };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse failed";
    const updated = await prisma.importQueue.update({
      where: { id },
      data: { status: "PARSE_FAILED", error: message },
    });
    const remaining = await countRemaining();
    logger.warn("queue.parse_finished", {
      id,
      status: "PARSE_FAILED",
      durationMs: Date.now() - startedAt,
      remaining,
      error: message,
    });
    return { processed: true, item: toDTO(updated), remaining };
  }
}

/**
 * Re-exported so queue callers have one obvious place to read the counter from.
 * The rule itself lives in the AI budget module, which every model-invoking path
 * shares — the queue only chooses how to PRESENT a refusal (a stop signal, not a
 * failed item), it does not decide the limit.
 */
export { countAnalysesToday };

/**
 * Whether ANY AI project can still run today, plus the numbers to report.
 *
 * Gating is per provider — each key lives in its own Google Cloud project with
 * its own quota — so "reached" means every project is spent or cooling down,
 * not that some pooled total ran out. The summed `used`/`limit` are for display
 * only; nothing decides anything from them.
 */
async function analysisBudgetSnapshot(): Promise<{
  reached: boolean;
  used: number;
  limit: number;
  /** When a purely temporary block lifts; null when the day is truly spent. */
  retryAfter: Date | null;
}> {
  const { available, usage } = await anyProviderAvailable();

  // A project that still has daily budget and is only waiting out a cooldown
  // will come back on its own. The soonest of those is when work can resume.
  const waiting = usage
    .filter((u) => !u.available && u.used < u.limit && u.cooldownUntil !== null)
    .map((u) => u.cooldownUntil!.getTime());

  return {
    reached: !available,
    used: usage.reduce((sum, u) => sum + u.used, 0),
    limit: usage.reduce((sum, u) => sum + u.limit, 0),
    retryAfter: waiting.length > 0 ? new Date(Math.min(...waiting)) : null,
  };
}

/**
 * Reads the follower count from an already-parsed profile.
 *
 * Returns `undefined` when there is no parsed profile at all (a parse problem,
 * which must stay a retryable failure) and `null` when the profile exists but
 * carries no usable follower count (a quality decision).
 */
function parsedFollowerCount(rawProfile: unknown): number | null | undefined {
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) return undefined;
  const value = (rawProfile as { followersCount?: unknown }).followersCount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Analyze stage: reloads the parsed payload and runs Gemini (NO Apify).
 * PENDING_ANALYSIS → ANALYZING → READY_FOR_REVIEW / ANALYSIS_FAILED.
 *
 * Two gates run BEFORE any AI call, in this order:
 *  1. Quality — an account below the follower threshold (or with no follower
 *     count) is worth no AI spend, so it lands in the terminal
 *     SKIPPED_LOW_FOLLOWERS. Its parsed data is preserved and, crucially, it
 *     consumes none of the daily allowance.
 *  2. Daily allowance — when today's AI calls are used up the item is left
 *     exactly as it was (PENDING_ANALYSIS) and the caller is told to stop.
 *
 * The order matters: gating on quality first is what lets a queue full of small
 * accounts keep draining for free instead of stalling behind the allowance.
 */
/**
 * Advances the Analyze stage for a WHOLE BATCH of queue items in one model call.
 *
 * The gates run per item and cost nothing: an unparsed row and a row below the
 * follower threshold are resolved here, before any model is involved, exactly
 * as they were when items were analyzed one at a time. What is left goes to the
 * model together — ONE request for up to `analysisBatchSize()` shops, which is
 * the entire point, since the daily allowance is spent per request.
 *
 * The batch is all-or-nothing on FAILURE but not on OUTCOME: a shop the model
 * declines to classify is skipped individually and the rest still land.
 */
async function runAnalyzeBatchStage(
  rows: { id: string; instagramUrl: string; importJobId: string | null }[],
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const done: ImportQueueItemDTO[] = [];
  const candidates: { id: string; instagramUrl: string; importJobId: string }[] = [];

  logger.info("queue.analyze_selected", {
    size: rows.length,
    ids: rows.map((r) => r.id),
  });

  // --- Gate 1: no linked parse job. A legacy row that cannot be analyzed. ---
  for (const row of rows) {
    if (!row.importJobId) {
      const message = "No parsed import job linked; re-parse required.";
      const updated = await prisma.importQueue.update({
        where: { id: row.id },
        data: { status: "ANALYSIS_FAILED", error: message },
      });
      logger.warn("queue.analyze_finished", { id: row.id, status: "ANALYSIS_FAILED", error: message });
      done.push(toDTO(updated));
      continue;
    }
    candidates.push({ ...row, importJobId: row.importJobId });
  }

  // --- Gate 2: follower quality. Costs no AI, so it is settled even when the
  // day's allowance is gone. ---
  const remainingCandidates: typeof candidates = [];
  for (const row of candidates) {
    const job = await prisma.importJob.findUnique({
      where: { id: row.importJobId },
      select: { rawProfile: true },
    });
    const followers = parsedFollowerCount(job?.rawProfile);
    const minFollowers = minFollowersForAnalysis();
    if (followers !== undefined && (followers === null || followers < minFollowers)) {
      const message =
        followers === null
          ? "Skipped: follower count unavailable."
          : `Skipped: ${followers.toLocaleString("en-US")} followers — below the ${minFollowers.toLocaleString("en-US")} minimum.`;
      const updated = await prisma.importQueue.update({
        where: { id: row.id },
        data: { status: "SKIPPED_LOW_FOLLOWERS", error: message },
      });
      logger.info("queue.analyze_skipped", {
        id: row.id,
        instagramUrl: row.instagramUrl,
        status: "SKIPPED_LOW_FOLLOWERS",
        followersCount: followers,
        minFollowers,
      });
      done.push(toDTO(updated));
      continue;
    }
    remainingCandidates.push(row);
  }

  if (remainingCandidates.length === 0) {
    const remaining = await countRemaining();
    return { processed: done.length > 0, item: done[0] ?? null, items: done, remaining };
  }

  // --- Gate 3: the day's allowance, read once for the whole batch. ---
  const budget = await analysisBudgetSnapshot();
  if (budget.reached) {
    const remaining = await countRemaining();
    const temporary = budget.retryAfter !== null;
    logger.info(temporary ? "queue.cooling_down" : "queue.daily_limit_reached", {
      ids: remainingCandidates.map((r) => r.id),
      analyzedToday: budget.used,
      limit: budget.limit,
      remaining,
      retryAfter: budget.retryAfter?.toISOString() ?? null,
    });
    // Left untouched in PENDING_ANALYSIS — resumed when the cooldown lifts, or
    // on the next business day when the budget is genuinely spent. Items the
    // gates already settled are still reported.
    return {
      processed: done.length > 0,
      item: done[0] ?? null,
      items: done,
      remaining,
      ...(temporary ? { retryAfter: budget.retryAfter!.toISOString() } : { dailyLimitReached: true }),
      analyzedToday: budget.used,
    };
  }

  // --- Prepare. A handle keys the model's answer, so it must be unique within
  // the batch; a repeat waits for the next one rather than making the reply
  // ambiguous. ---
  const prepared: PreparedAnalysisJob[] = [];
  const byJobId = new Map<string, { id: string; instagramUrl: string }>();
  const seenHandles = new Set<string>();
  for (const row of remainingCandidates) {
    try {
      const job = await prepareAnalysisJob(row.importJobId);
      const key = job.handle.toLocaleLowerCase("en-US");
      if (seenHandles.has(key)) {
        logger.info("queue.analyze_deferred", { id: row.id, handle: job.handle, reason: "duplicate handle in batch" });
        continue;
      }
      seenHandles.add(key);
      prepared.push(job);
      byJobId.set(job.jobId, { id: row.id, instagramUrl: row.instagramUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis preparation failed";
      const updated = await prisma.importQueue.update({
        where: { id: row.id },
        data: { status: "ANALYSIS_FAILED", error: message },
      });
      logger.warn("queue.analyze_finished", { id: row.id, status: "ANALYSIS_FAILED", error: message });
      done.push(toDTO(updated));
    }
  }

  if (prepared.length === 0) {
    const remaining = await countRemaining();
    return { processed: done.length > 0, item: done[0] ?? null, items: done, remaining };
  }

  const queueIds = prepared.map((j) => byJobId.get(j.jobId)!.id);
  await prisma.importQueue.updateMany({
    where: { id: { in: queueIds } },
    data: { status: "ANALYZING" },
  });

  // --- One model call for the whole batch. ---
  try {
    const { batch, providerId } = await analyzeBatchWithPool(
      prepared.map((j) => ({ handle: j.handle, request: j.prepared.request })),
      { context: { path: "queue-analyze-batch", size: prepared.length } },
    );

    const skippedByHandle = new Map(batch.skipped.map((s) => [s.handle, s.reason]));

    for (const job of prepared) {
      const row = byJobId.get(job.jobId)!;
      const result = batch.results.get(job.handle);

      if (result) {
        await applyAnalysisResult(job, result, providerId);
        const updated = await prisma.importQueue.update({
          where: { id: row.id },
          data: { status: "READY_FOR_REVIEW", error: null },
        });
        done.push(toDTO(updated));
        continue;
      }

      // Declined by the model. Not a system failure and not an analysis: the
      // row keeps its parsed data, carries the reason, and stays retryable by
      // hand — it is NOT sent back to the model on its own.
      const reason = skippedByHandle.get(job.handle) ?? "no reason given";
      const message = `Skipped by AI: ${reason}`;
      await markAnalysisJobFailed(job.jobId, message);
      const updated = await prisma.importQueue.update({
        where: { id: row.id },
        data: { status: "ANALYSIS_FAILED", error: message },
      });
      logger.info("queue.analyze_ai_skipped", { id: row.id, handle: job.handle, reason });
      done.push(toDTO(updated));
    }

    const remaining = await countRemaining();
    logger.info("queue.analyze_batch_finished", {
      status: "success",
      provider: providerId,
      size: prepared.length,
      handles: prepared.map((j) => j.handle),
      results: batch.results.size,
      skipped: batch.skipped.length,
      durationMs: Date.now() - startedAt,
      remaining,
    });
    return {
      processed: true,
      item: done[0] ?? null,
      items: done,
      remaining,
      analyzedToday: await countAnalysesToday(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    // The whole batch failed, so no shop in it was analyzed: every row goes
    // back as retryable, and none of them carries an analyzedAt.
    for (const job of prepared) {
      const row = byJobId.get(job.jobId)!;
      await markAnalysisJobFailed(job.jobId, message).catch(() => undefined);
      const updated = await prisma.importQueue.update({
        where: { id: row.id },
        data: { status: "ANALYSIS_FAILED", error: message },
      });
      done.push(toDTO(updated));
    }
    const remaining = await countRemaining();
    logger.warn("queue.analyze_batch_finished", {
      status: "failed",
      size: prepared.length,
      handles: prepared.map((j) => j.handle),
      error: message,
      errorStatus: error instanceof AiCategoryProviderError ? (error.status ?? null) : null,
      durationMs: Date.now() - startedAt,
      remaining,
    });
    // A failed AI call still consumed quota, so it still counts toward today.
    return {
      processed: true,
      item: done[0] ?? null,
      items: done,
      remaining,
      analyzedToday: await countAnalysesToday(),
    };
  }
}

/** Count of items still needing work (any stage before a terminal status). */
async function countRemaining(): Promise<number> {
  return prisma.importQueue.count({ where: { status: { in: [...ACTIONABLE_STATUSES] } } });
}
