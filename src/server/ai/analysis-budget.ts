import "server-only";

import { dailyAnalysisLimit } from "@/config/limits";
import { startOfBusinessDay } from "@/lib/business-day";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The per-business-day AI budget — the SINGLE place the analysis limit is
 * decided. Every path that can invoke the model (the import queue's Analyze
 * stage, Auto Import, Process All, and the manual single-import flow) goes
 * through {@link reserveAiInvocation}, so there is exactly one rule and one
 * counter rather than a check per entry point.
 *
 * The counter is `ImportJob.analyzedAt`, stamped at the moment a request is
 * issued — before its outcome is known — because a failed request still
 * consumed the provider's daily quota. Undercounting there is precisely the
 * case this budget exists to contain.
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
      `Daily analysis limit reached (${used}/${limit} AI requests used today). ` +
        `Remaining work resumes on the next business day.`,
    );
    this.name = "DailyAnalysisLimitError";
    this.used = used;
    this.limit = limit;
  }
}

/** AI calls issued so far in the current business day (Asia/Almaty by default). */
export async function countAnalysesToday(now: Date = new Date()): Promise<number> {
  return prisma.importJob.count({ where: { analyzedAt: { gte: startOfBusinessDay(now) } } });
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
 * Claims one AI request for `jobId`: refuses when the allowance is spent,
 * otherwise records the invocation so it counts from this moment on.
 *
 * Call this IMMEDIATELY before handing the request to the provider. Stamping
 * first is what makes a failed call count, and re-checking here (rather than
 * trusting an earlier {@link assertAiInvocationAllowed}) closes the window
 * between an early check and the actual call.
 */
export async function reserveAiInvocation(jobId: string, providerName: string): Promise<void> {
  if (providerName === "disabled") return;
  await assertAiInvocationAllowed(providerName, { jobId });
  await prisma.importJob.update({ where: { id: jobId }, data: { analyzedAt: new Date() } });
}
