import "server-only";

import { dailyAnalysisLimit } from "@/config/limits";
import { startOfBusinessDay } from "@/lib/business-day";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Record of finished ANALYSES — which boutiques the model actually profiled.
 *
 * `ImportJob.analyzedAt` is stamped only once the model returned a usable
 * result, together with `analyzedBy`. A transient failure (a 503 blip, a
 * timeout, a 429) leaves no stamp, because nothing was analyzed.
 *
 * This is NOT the provider's quota counter, and the difference matters. Google
 * charges for REQUESTS, failures included; one analysis can cost several of
 * them through retries, and a bad day can spend fifty requests to produce five
 * analyses. A gate built on this number therefore reads far too low and keeps
 * sending requests long after the allowance is gone — which is exactly what
 * happened in production. Requests are counted in their own ledger
 * (`server/ai/request-ledger.ts`), and that is what gates the pool.
 *
 * So: this module answers "what did we analyze today"; the ledger answers "how
 * much allowance is left". Both are needed, and neither can do the other's job.
 *
 * This is also separate from the Telegram publication limit: one caps AI spend,
 * the other caps how much is posted, and neither constrains the other.
 */

/**
 * Raised when a call is refused because today's AI allowance is spent. `used`
 * and `limit` are REQUESTS when the pool raises it (see NoProviderAvailableError).
 */
export class DailyAnalysisLimitError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(
      `Daily AI limit reached (${used}/${limit} used today). ` +
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
 * Today's analysis count against the configured limit.
 *
 * NOT the provider gate — the pool gates on the request ledger, which counts
 * what Google counts. Kept for reporting and for a single-provider setup.
 */
export async function checkDailyAnalysisBudget(now: Date = new Date()): Promise<AnalysisBudget> {
  const [used, limit] = [await countAnalysesToday(now), dailyAnalysisLimit()];
  return { reached: used >= limit, used, limit };
}

/**
 * Throws {@link DailyAnalysisLimitError} when today's analysis count is spent.
 *
 * Superseded as the pool's gate by `assertProviderAvailable`, which reads the
 * request ledger. Kept for callers that ration finished analyses rather than
 * provider quota. A disabled provider issues no request, so it is never
 * budgeted.
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
