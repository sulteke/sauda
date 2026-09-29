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
/**
 * How many boutiques may be posted to the channel in a day.
 *
 * This is an editorial number, not a technical one — Telegram rate-limits a
 * chat by the MINUTE, and nothing near this figure comes close to that. It sat
 * at 20 only because it was written alongside the AI limit, which is 20 for a
 * real reason (the provider's free tier allows that many requests a day). The
 * two were never related, and matching them held publishing to a ceiling that
 * the import pipeline had long outgrown.
 *
 * Override per environment: DAILY_TELEGRAM_PUBLISH_LIMIT.
 */
export const DEFAULT_DAILY_TELEGRAM_PUBLISH_LIMIT = 50;

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

// --- AI providers ------------------------------------------------------------
//
// Gemini's rate limits apply per Google Cloud PROJECT, not per API key, so two
// keys only add capacity when they belong to two different projects. Each
// provider therefore carries its OWN daily limit: there is no global "40/day"
// anywhere, because the real ceiling is whatever each project's RPD happens to
// be, and the two need not match.

export const DEFAULT_PROVIDER_DAILY_LIMIT = 20;
/**
 * Where the provider's daily allowance rolls over. Google's free-tier RPD
 * resets at midnight Pacific, roughly twelve hours away from the Almaty
 * business day, so counting requests on the business day would leave our
 * ledger permanently half a day out of step with the quota it is tracking.
 * Override: GEMINI_QUOTA_RESET_TZ.
 */
export const DEFAULT_QUOTA_RESET_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_PROVIDER_COOLDOWN_MINUTES = 10;

/** AI REQUESTS per quota day allowed on the PRIMARY project. */
export function geminiPrimaryDailyLimit(): number {
  return positiveInt(process.env.GEMINI_PRIMARY_DAILY_LIMIT, DEFAULT_PROVIDER_DAILY_LIMIT);
}

/** AI REQUESTS per quota day allowed on the FALLBACK project. */
export function geminiFallbackDailyLimit(): number {
  return positiveInt(process.env.GEMINI_FALLBACK_DAILY_LIMIT, DEFAULT_PROVIDER_DAILY_LIMIT);
}

export const DEFAULT_ANALYSIS_BATCH_SIZE = 3;

/**
 * How many profiles one model request covers.
 *
 * The provider's allowance is spent per REQUEST, so three shops answered
 * together cost a third of three separate calls. Kept small on purpose: the
 * more shops share a prompt, the more the model's attention is divided and the
 * more a single failure costs, and three is enough to turn a 20-request day
 * into a 60-profile one. Override: ANALYSIS_BATCH_SIZE.
 */
export function analysisBatchSize(): number {
  // A batch answers one shop per THIRD of a request, which is worth having only
  // where requests are the scarce thing. Wherever the local model is in the
  // pool they are not: it has no allowance to spend, and the scarce thing is
  // context. Three real shops build a ~21k-character prompt — 20 posts of
  // captions each — which overflows the window and fails all three at once.
  //
  // The condition is localAiEnabled, NOT localAiOnly, and the difference is the
  // whole point of routing by size. A batch shares one prompt, so it is routed
  // as one: three shops together are over the size limit almost every time, so
  // batching would send every shop to Gemini and the local model would never
  // run at all — which is exactly what happened when this said localAiOnly.
  // At one shop per request each is routed on its own size: the small ones go
  // to the local model for free, and only the large ones spend Gemini.
  //
  // Production has no local entry, so it keeps batching three.
  if (localAiEnabled()) return 1;
  return positiveInt(process.env.ANALYSIS_BATCH_SIZE, DEFAULT_ANALYSIS_BATCH_SIZE);
}

// --- Local AI (development only) -------------------------------------------
//
// A model running on the developer's own machine, used as a LAST resort after
// both Gemini projects. It exists so a Gemini outage does not stop local work;
// it is off unless explicitly switched on, so production behaves exactly as it
// did before this existed.

export const DEFAULT_LOCAL_AI_BASE_URL = "http://127.0.0.1:1234";
export const DEFAULT_LOCAL_AI_MODEL = "qwen/qwen3-8b";
/**
 * Room reserved for the model's ANSWER.
 *
 * It is not free: the server reserves it out of the same context window the
 * prompt has to fit in, so every token promised here is a token the profile
 * cannot use. One shop's answer runs six categories and a sentence — well
 * under a thousand tokens — and the local model analyzes exactly one shop at a
 * time, so 2048 is already double what the job needs, and the headroom it
 * gives back is what lets a real 20-post profile fit at all.
 */
export const DEFAULT_LOCAL_AI_MAX_TOKENS = 2048;
/**
 * How long one local call may take.
 *
 * An 8B model on a laptop answers a three-shop batch in roughly 60-90 seconds —
 * an order of magnitude slower than hosted Gemini. This is deliberately generous
 * because the alternative is aborting a call that WOULD have succeeded; a local
 * model has no quota to protect, so patience costs nothing but time.
 */
export const DEFAULT_LOCAL_AI_TIMEOUT_MS = 180_000;

/**
 * Whether the local model may be used at all.
 *
 * Requires the exact string "true": anything else — unset, empty, "1", "yes",
 * a stray space — leaves it off. A local endpoint must never become reachable
 * from production by accident, so the check refuses to be clever.
 */
export function localAiEnabled(): boolean {
  return process.env.LOCAL_AI_ENABLED === "true";
}

/**
 * Run the pool on the LOCAL model alone, skipping Gemini entirely.
 *
 * For development against a local database, where the point is to exercise the
 * real workflow without spending a hosted quota that a shared free tier hands
 * out twenty of a day. Requires localAiEnabled() as well, so one flag can never
 * silently disable Gemini on its own.
 */
export function localAiOnly(): boolean {
  return localAiEnabled() && process.env.LOCAL_AI_ONLY === "true";
}

export function localAiBaseUrl(): string {
  return process.env.LOCAL_AI_BASE_URL || DEFAULT_LOCAL_AI_BASE_URL;
}

export function localAiModel(): string {
  return process.env.LOCAL_AI_MODEL || DEFAULT_LOCAL_AI_MODEL;
}

export function localAiMaxTokens(): number {
  return positiveInt(process.env.LOCAL_AI_MAX_TOKENS, DEFAULT_LOCAL_AI_MAX_TOKENS);
}

/**
 * Profile size past which the local model stops being the right tool.
 *
 * Measured against what the 8B model actually did on real profiles. Everything
 * it analyzed successfully came in at or under ~6,200 characters of profile
 * text; everything from ~13,400 up failed, and in three different ways — one
 * ran the full timeout without stopping, one answered at length in prose
 * instead of JSON, and one took LM Studio's backend down with it, which
 * stopped every shop queued behind it too.
 *
 * Ten thousand sits in that gap. It is not a promise: a small profile can
 * still fail on how the model behaves rather than how much it was given — one
 * at 1,677 characters did. What the threshold buys is that the failures which
 * ARE about size stop happening, and that the one which takes the server down
 * never gets the chance.
 *
 * Counts the parts that vary with the shop — bio, captions, hashtags, mentions
 * — and not the taxonomy, which is the same in every prompt.
 *
 * Override: LOCAL_MAX_PROFILE_CHARS.
 */
export const DEFAULT_LOCAL_MAX_PROFILE_CHARS = 10_000;

export function localMaxProfileChars(): number {
  return positiveInt(process.env.LOCAL_MAX_PROFILE_CHARS, DEFAULT_LOCAL_MAX_PROFILE_CHARS);
}

/**
 * Wall-clock ceiling for a single local call, used by BOTH the provider's own
 * abort timer and the pool's per-provider budget.
 *
 * One source of truth on purpose: when the pool's cap was a Gemini-shaped
 * constant, it cut local calls off at 28s — well before a model that needs 77s
 * could answer — and the failure looked like a broken provider rather than an
 * impatient caller.
 */
export function localAiTimeoutMs(): number {
  return positiveInt(process.env.LOCAL_AI_TIMEOUT_MS, DEFAULT_LOCAL_AI_TIMEOUT_MS);
}

/** Time zone whose midnight rolls the provider's request allowance over. */
export function quotaResetTimeZone(): string {
  return process.env.GEMINI_QUOTA_RESET_TZ || DEFAULT_QUOTA_RESET_TIME_ZONE;
}

/**
 * How long a project is skipped after a per-MINUTE rate limit. Short by design:
 * an RPM bounce clears in well under a minute, and parking the project for ten
 * would waste an allowance that is still there. Override:
 * GEMINI_RATE_LIMIT_COOLDOWN_SECONDS.
 */
export function rateLimitCooldownMs(): number {
  return positiveInt(process.env.GEMINI_RATE_LIMIT_COOLDOWN_SECONDS, 60) * 1_000;
}

/**
 * How long a provider is skipped after a 429 / 503 / timeout / network error.
 *
 * Long enough that the next few boutiques do not re-discover the same outage,
 * short enough that a brief blip does not sideline a healthy project for the
 * rest of the day. Override: GEMINI_PROVIDER_COOLDOWN_MINUTES.
 */
export function providerCooldownMs(): number {
  const minutes = positiveInt(
    process.env.GEMINI_PROVIDER_COOLDOWN_MINUTES,
    DEFAULT_PROVIDER_COOLDOWN_MINUTES,
  );
  return minutes * 60_000;
}
