/**
 * Operational limits for the import → review → publish pipeline.
 *
 * Every value is env-overridable and read at call time (never captured at
 * module load), so a Vercel env change takes effect without a code deploy and
 * tests can set a value per-case.
 */

/** Parses a positive-integer env var, falling back when unset or malformed. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS = 5_000;
export const DEFAULT_DAILY_ANALYSIS_LIMIT = 20;
export const DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT = 20;

/**
 * Quality gate. An account needs AT LEAST this many followers to be worth an AI
 * call; anything below it (and anything with no follower count at all) is
 * skipped before Gemini is touched. Override: MIN_FOLLOWERS_FOR_ANALYSIS.
 */
export function minFollowersForAnalysis(): number {
  return positiveInt(process.env.MIN_FOLLOWERS_FOR_ANALYSIS, DEFAULT_MIN_FOLLOWERS_FOR_ANALYSIS);
}

/**
 * Maximum AI invocations per business day. Counts EVERY call actually issued —
 * including ones that error — because a failed request still consumes the
 * provider's daily quota. Override: DAILY_ANALYSIS_LIMIT.
 */
export function dailyAnalysisLimit(): number {
  return positiveInt(process.env.DAILY_ANALYSIS_LIMIT, DEFAULT_DAILY_ANALYSIS_LIMIT);
}

/**
 * Maximum SUCCESSFUL Telegram publications per business day. Entirely separate
 * from the AI limit: skipped, failed, pending and approved-but-unpublished
 * boutiques never count. Override: DAILY_TELEGRAM_PUBLISH_LIMIT.
 */
export function dailyTelegramPublishLimit(): number {
  return positiveInt(
    process.env.DAILY_TELEGRAM_PUBLISH_LIMIT,
    DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT,
  );
}
