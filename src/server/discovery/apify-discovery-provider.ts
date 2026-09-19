import "server-only";

import { logger } from "@/lib/logger";

import {
  DEFAULT_DISCOVERY_PAGE_SIZE,
  DEFAULT_TARGET_NEW_ACCOUNTS,
  type DiscoverOptions,
  type DiscoveredAccount,
  type DiscoveryProvider,
  type DiscoverySeed,
} from "./discovery-provider";
import {
  DiscoveryNotFoundError,
  DiscoveryPrivateAccountError,
  DiscoveryProviderError,
} from "./errors";

const DEFAULT_BASE_URL = "https://api.apify.com";
const DEFAULT_PROFILE_ACTOR = "apify~instagram-profile-scraper";
// Hashtag actor. The official Instagram actors only return the anonymous
// first-page sample (~6 posts) for a hashtag; this actor scrapes through a
// no-login data-provider lane and actually returns the requested volume (each
// post carries `ownerUsername`). Overridable via APIFY_DISCOVERY_HASHTAG_ACTOR.
const DEFAULT_HASHTAG_ACTOR = "dami_studio~instagram-hashtag-scraper";
// Below the Vercel Hobby 60s function limit so a slow run aborts cleanly on our
// side rather than being killed by the platform. Overridable via
// APIFY_DISCOVERY_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 55_000;
// Posts pulled per synchronous run, overridable via APIFY_DISCOVERY_RESULTS_LIMIT.
// The sync dataset endpoint returns the whole set at once, so this is bounded by
// the Vercel Hobby 60s limit: measured ~0.45s/post for the default actor, so 80
// posts ≈ 40s (≈50 unique owners) leaves comfortable headroom. Raising it fetches
// more owners but risks the 60s cutoff (≈150 posts ≈ 68s already exceeds it).
const DEFAULT_RESULTS_LIMIT = 80;
const MAX_ATTEMPTS = 2; // initial try + one retry
const RETRY_DELAY_MS = 1_500; // gentle backoff between retries

// --- Apify payload shapes (defensive; not exported) -----------------------

interface ApifyRelatedProfile {
  username?: string;
  full_name?: string | null;
  profile_pic_url?: string | null;
  is_private?: boolean;
}

interface ApifyProfileItem {
  username?: string;
  private?: boolean;
  isPrivate?: boolean;
  error?: string;
  relatedProfiles?: unknown;
}

interface ApifyHashtagPost {
  ownerUsername?: string;
  ownerFullName?: string | null;
}

function normalizeActorId(id: string): string {
  return id.replace(/\//g, "~");
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function profileUrl(username: string): string {
  return `https://www.instagram.com/${username.toLowerCase()}/`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApifyDiscoveryProviderOptions {
  token?: string;
  baseUrl?: string;
  profileActorId?: string;
  hashtagActorId?: string;
  timeoutMs?: number;
  resultsLimit?: number;
}

/**
 * Real discovery source backed by the official Apify REST API. It never scrapes
 * for import — it only discovers candidate accounts:
 *   - profile seed  -> the profile's related accounts (following needs login → n/a)
 *   - hashtag seed  -> public accounts posting under the hashtag
 * Everything is normalized to DiscoveredAccount; Apify details stay in this file.
 */
export class ApifyDiscoveryProvider implements DiscoveryProvider {
  readonly name = "apify";

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly profileActorId: string;
  private readonly hashtagActorId: string;
  private readonly timeoutMs: number;
  private readonly resultsLimit: number;

  constructor(options: ApifyDiscoveryProviderOptions = {}) {
    const envTimeout = Number(process.env.APIFY_DISCOVERY_TIMEOUT_MS);
    this.token = options.token ?? process.env.APIFY_TOKEN ?? "";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.profileActorId = normalizeActorId(
      options.profileActorId ?? process.env.APIFY_DISCOVERY_PROFILE_ACTOR ?? DEFAULT_PROFILE_ACTOR,
    );
    this.hashtagActorId = normalizeActorId(
      options.hashtagActorId ?? process.env.APIFY_DISCOVERY_HASHTAG_ACTOR ?? DEFAULT_HASHTAG_ACTOR,
    );
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    const envLimit = Number(process.env.APIFY_DISCOVERY_RESULTS_LIMIT);
    this.resultsLimit =
      options.resultsLimit ??
      (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_RESULTS_LIMIT);
  }

  async discover(seed: DiscoverySeed, options: DiscoverOptions = {}): Promise<DiscoveredAccount[]> {
    if (!this.token) {
      throw new DiscoveryProviderError("APIFY_TOKEN is not configured.");
    }

    // The hashtag path paginates and filters against the DB internally, so it
    // already returns a deduped, NEW-only list. The profile path returns a fixed
    // set of related accounts, deduped here.
    if (seed.type === "HASHTAG") {
      return this.discoverByHashtag(seed.value, options);
    }

    const accounts = await this.discoverByProfile(seed.value);
    return this.dedupe(accounts, seed);
  }

  /**
   * Discovers NEW accounts posting under a hashtag. One bounded Apify run returns
   * the hashtag's recent posts; we then walk them page by page, and for EACH page
   * normalize owners → dedupe within the run → skip accounts already in the DB →
   * keep the new ones. We keep consuming pages until we have collected
   * `targetNewCount` new accounts OR we run out of results ("no more pages").
   * A page that contributes zero new accounts is NOT a stop condition — we only
   * stop on the target or on exhausting the fetched results.
   */
  private async discoverByHashtag(
    tag: string,
    options: DiscoverOptions,
  ): Promise<DiscoveredAccount[]> {
    const targetNew = options.targetNewCount ?? DEFAULT_TARGET_NEW_ACCOUNTS;
    const pageSize = options.pageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE;

    // Union input so the actor stays swappable via APIFY_DISCOVERY_HASHTAG_ACTOR
    // with NO per-actor (and NO per-hashtag) branching: the `hashtags` array feeds
    // hashtag actors (e.g. dami_studio), while `directUrls`/`resultsType` feed the
    // general instagram-scraper — each actor reads the fields it knows and ignores
    // the rest. `encodeURIComponent` keeps non-ASCII tags (e.g. Cyrillic) valid.
    // Single attempt (no retry): a hashtag scrape is slow, so a retry could stack
    // two ~55s attempts and overrun the function. One attempt keeps the actor call
    // bounded by the ~55s per-attempt timeout.
    const posts = await this.runActor<ApifyHashtagPost>(
      this.hashtagActorId,
      {
        hashtags: [tag],
        directUrls: [`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`],
        resultsType: "posts",
        resultsLimit: this.resultsLimit,
      },
      1,
    );

    // TEMP DIAGNOSTIC: proves the paginating code path is the one running, and
    // whether a DB dedup checker was actually injected.
    logger.info("discovery.hashtag.start", {
      tag,
      totalPosts: posts.length,
      resultsLimit: this.resultsLimit,
      pageSize,
      targetNew,
      hasKnownChecker: Boolean(options.isKnownHandles),
    });

    const collected: DiscoveredAccount[] = [];
    const seen = new Set<string>(); // dedupe across the whole run
    let pagesChecked = 0;
    let accountsSeen = 0; // unique accounts actually examined against the DB
    let existingAccounts = 0; // of those, how many already existed

    for (let start = 0; start < posts.length && collected.length < targetNew; start += pageSize) {
      pagesChecked += 1;
      const page = posts.slice(start, start + pageSize);

      // Normalize this page's owners and drop duplicates already seen in the run.
      const pageAccounts: DiscoveredAccount[] = [];
      for (const post of page) {
        const username = toStringOrNull(post.ownerUsername);
        if (!username) continue;
        const handle = username.toLowerCase();
        if (seen.has(handle)) continue;
        seen.add(handle);
        pageAccounts.push({
          handle,
          instagramUrl: profileUrl(username),
          fullName: toStringOrNull(post.ownerFullName),
          avatarUrl: null,
          followersCount: null,
        });
      }

      // Skip accounts that already exist in the DB (imported or discovered).
      const known =
        options.isKnownHandles && pageAccounts.length > 0
          ? await options.isKnownHandles(pageAccounts.map((account) => account.handle))
          : new Set<string>();

      let knownThisPage = 0;
      let newThisPage = 0;
      for (const account of pageAccounts) {
        accountsSeen += 1;
        if (known.has(account.handle)) {
          existingAccounts += 1;
          knownThisPage += 1;
          continue;
        }
        collected.push(account);
        newThisPage += 1;
        if (collected.length >= targetNew) break;
      }

      // TEMP DIAGNOSTIC: per-page Fetched / Already known / New counts.
      logger.info("discovery.page", {
        tag,
        page: pagesChecked,
        fetched: pageAccounts.length,
        alreadyKnown: knownThisPage,
        new: newThisPage,
        collected: collected.length,
        target: targetNew,
      });
    }

    // TEMP DIAGNOSTIC: if NO page yielded a usable account, the owner field is
    // probably not `ownerUsername`. Dump ONE raw Apify item (keys + item) so we
    // can see which field actually carries the Instagram handle. First item only.
    if (accountsSeen === 0 && posts.length > 0) {
      const firstItem = posts[0] as unknown as Record<string, unknown>;
      logger.info("discovery.raw_item", {
        tag,
        keys: Object.keys(firstItem ?? {}),
        item: firstItem,
      });
    }

    const stoppedReason = collected.length >= targetNew ? "target_reached" : "dataset_exhausted";

    logger.info("discovery.pagination", {
      hashtag: tag,
      resultsLimit: this.resultsLimit,
      pagesChecked,
      accountsSeen,
      existingAccounts,
      newAccounts: collected.length,
      returnedAccounts: collected.length,
      stoppedReason,
    });

    return collected;
  }

  private async discoverByProfile(handle: string): Promise<DiscoveredAccount[]> {
    const items = await this.runActor<ApifyProfileItem>(this.profileActorId, {
      usernames: [handle],
    });

    const profile = items[0];
    if (!profile || profile.error || !toStringOrNull(profile.username)) {
      throw new DiscoveryNotFoundError(
        `Instagram profile @${handle} was not found (it may be deleted).`,
      );
    }

    const related = Array.isArray(profile.relatedProfiles)
      ? (profile.relatedProfiles as ApifyRelatedProfile[])
      : [];

    const accounts: DiscoveredAccount[] = [];
    for (const entry of related) {
      const username = toStringOrNull(entry.username);
      if (!username) continue;
      accounts.push({
        handle: username.toLowerCase(),
        instagramUrl: profileUrl(username),
        fullName: toStringOrNull(entry.full_name),
        avatarUrl: toStringOrNull(entry.profile_pic_url),
        followersCount: null,
      });
    }

    if (accounts.length === 0 && (profile.private ?? profile.isPrivate)) {
      throw new DiscoveryPrivateAccountError(
        `Instagram profile @${handle} is private; no related accounts were discoverable.`,
      );
    }

    return accounts;
  }

  private dedupe(accounts: DiscoveredAccount[], seed: DiscoverySeed): DiscoveredAccount[] {
    const seen = new Set<string>();
    const seedHandle = seed.type === "PROFILE" ? seed.value.toLowerCase() : null;
    const result: DiscoveredAccount[] = [];

    for (const account of accounts) {
      const key = account.handle.toLowerCase();
      if (seen.has(key) || key === seedHandle) continue; // dedupe + never suggest the seed
      seen.add(key);
      result.push(account);
    }
    return result;
  }

  private endpoint(actorId: string): string {
    return `${this.baseUrl}/v2/acts/${actorId}/run-sync-get-dataset-items`;
  }

  /**
   * Runs an actor with a bounded number of attempts. `maxAttempts` defaults to
   * MAX_ATTEMPTS (used by the quick profile call), but the hashtag path passes 1:
   * a single slow attempt must not be able to start a second ~55s attempt and
   * stack toward the function limit. With one attempt the actor call is bounded
   * by the per-attempt AbortController (APIFY_DISCOVERY_TIMEOUT_MS ≈ 55s), so a
   * slow run aborts cleanly with a 502 error instead of overrunning the request.
   */
  private async runActor<T>(
    actorId: string,
    input: Record<string, unknown>,
    maxAttempts: number = MAX_ATTEMPTS,
  ): Promise<T[]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.callApify<T>(actorId, input, attempt);
      } catch (error) {
        lastError = error;
        logger.warn("discovery.apify.attempt_failed", {
          actorId,
          attempt,
          maxAttempts,
          error: errorMessage(error),
        });
        if (attempt < maxAttempts) await sleep(RETRY_DELAY_MS); // backoff
      }
    }

    throw new DiscoveryProviderError(
      `Apify discovery failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}.`,
      { cause: lastError },
    );
  }

  private async callApify<T>(
    actorId: string,
    input: Record<string, unknown>,
    attempt: number,
  ): Promise<T[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(this.endpoint(actorId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new DiscoveryProviderError(`Apify responded with HTTP ${response.status}.`, {
          status: response.status,
        });
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new DiscoveryProviderError("Apify returned an unexpected payload.");
      }

      logger.info("discovery.apify.ok", {
        actorId,
        attempt,
        durationMs: Date.now() - startedAt,
        items: payload.length,
      });

      return payload as T[];
    } catch (error) {
      if (isAbortError(error)) {
        throw new DiscoveryProviderError(`Apify discovery timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
