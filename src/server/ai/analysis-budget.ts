import "server-only";

import { dailyAnalysisLimit } from "@/config/limits";
import { startOfBusinessDay } from "@/lib/business-day";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The per-business-day AI budget — the SINGLE place the analysis limit is
 * decided. Every path that can invoke the model (the import queue's Analyze
 * stage, Auto Import, Process All, and the manual single-import flow) uses the
 * same two steps: {@link assertAiInvocationAllowed} before the call, and
 * {@link recordSuccessfulAnalysis} after it SUCCEEDS. So there is one rule and
 * one counter rather than a check per entry point.
 *
 * The counter is `ImportJob.analyzedAt`, stamped only once the model returned a
 * usable result. A transient failure (a 503 blip, a timeout, a 429) therefore
 * costs NO daily slot: the day's allowance is spent on analyses that actually
 * produced something, not on requests that errored out.
 *
 * (This reverses the earlier "count every invocation" rule. That rule was meant
 * to protect the provider's free-tier quota, but it never tracked it accurately
 * — retries make one invocation several HTTP requests — and in practice it let
 * a flaky provider burn the whole day's budget on failures. Counting successes
 * keeps the limit tied to the thing it exists to ration: finished analyses.)
 *
 * This is deliberately separate from the Telegram publication limit: one caps
 * AI spend, the other caps how much is posted, and neither constrains the other.
 */

/** Raised when a call is refused because today's AI allowance is spent. */
export class DailyAnalysisLimitError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(
      `Daily analysis limit reached (${used}/${limit} successful analyses today). ` +
        `Remaining work resumes on the next business day.`,
    );
    this.name = "DailyAnalysisLimitError";
    this.used = used;
    this.limit = limit;
  }
}

/**
 * Successful analyses so far in the current business day (Asia/Almaty default).
 *
 * With `providerId`, counts only the ones that provider produced. Each provider
 * draws on its own Google Cloud project, so their quotas are genuinely separate
 * and must never be pooled into one number. Without it, counts every provider —
 * used for reporting, not for gating.
 */
export async function countAnalysesToday(
  now: Date = new Date(),
  providerId?: string,
): Promise<number> {
  return prisma.importJob.count({
    where: {
      analyzedAt: { gte: startOfBusinessDay(now) },
      ...(providerId ? { analyzedBy: providerId } : {}),
    },
  });
}

export interface AnalysisBudget {
  reached: boolean;
  used: number;
  limit: number;
}

/**
 * Today's budget, for callers that must react without throwing — the queue
 * reports "limit reached" as a stop signal rather than as a failed item.
 */
export async function checkDailyAnalysisBudget(now: Date = new Date()): Promise<AnalysisBudget> {
  const [used, limit] = [await countAnalysesToday(now), dailyAnalysisLimit()];
  return { reached: used >= limit, used, limit };
}

/**
 * Throws {@link DailyAnalysisLimitError} when today's allowance is spent.
 *
 * Callers use this to bail out EARLY — before scraping or mutating anything —
 * so a refused import costs no Apify credit and leaves no half-finished row.
 * A disabled provider issues no request, so it is never budgeted.
 */
export async function assertAiInvocationAllowed(
  providerName: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  if (providerName === "disabled") return;
  const { reached, used, limit } = await checkDailyAnalysisBudget();
  if (reached) {
    logger.info("ai.daily_limit_reached", { ...context, provider: providerName, used, limit });
    throw new DailyAnalysisLimitError(used, limit);
  }
}

/**
 * Records that `jobId` was analyzed SUCCESSFULLY — stamps `analyzedAt`, which
 * is what the daily counter reads.
 *
 * Call this AFTER the model returned a usable result, never before: that is the
 * whole point of the budget change. A run that failed (throwing, or degrading
 * to keyword-only for a disabled provider) must not reach this, so its slot
 * stays available. The disabled provider issues no request and produces no AI
 * analysis, so it is never recorded.
 */
export async function recordSuccessfulAnalysis(
  jobId: string,
  providerName: string,
  providerId?: string,
): Promise<void> {
  if (providerName === "disabled") return;
  await prisma.importJob.update({
    where: { id: jobId },
    // Written together, always: a slot only exists because some provider
    // produced it, so attributing it is part of recording it.
    data: { analyzedAt: new Date(), analyzedBy: providerId ?? providerName },
  });
}
