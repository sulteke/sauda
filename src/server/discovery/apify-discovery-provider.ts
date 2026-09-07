import "server-only";

import { logger } from "@/lib/logger";

import type { DiscoveredAccount, DiscoveryProvider, DiscoverySeed } from "./discovery-provider";
import {
  DiscoveryNotFoundError,
  DiscoveryPrivateAccountError,
  DiscoveryProviderError,
} from "./errors";

const DEFAULT_BASE_URL = "https://api.apify.com";
const DEFAULT_PROFILE_ACTOR = "apify~instagram-profile-scraper";
const DEFAULT_HASHTAG_ACTOR = "apify~instagram-hashtag-scraper";
const DEFAULT_TIMEOUT_MS = 90_000; // discovery scrapes can be slow
const DEFAULT_RESULTS_LIMIT = 50; // bounded — respect rate limits / cost
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
    this.resultsLimit = options.resultsLimit ?? DEFAULT_RESULTS_LIMIT;
  }

  async discover(seed: DiscoverySeed): Promise<DiscoveredAccount[]> {
    if (!this.token) {
      throw new DiscoveryProviderError("APIFY_TOKEN is not configured.");
    }

    const accounts =
      seed.type === "HASHTAG"
        ? await this.discoverByHashtag(seed.value)
        : await this.discoverByProfile(seed.value);

    return this.dedupe(accounts, seed);
  }

  private async discoverByHashtag(tag: string): Promise<DiscoveredAccount[]> {
    const posts = await this.runActor<ApifyHashtagPost>(this.hashtagActorId, {
      hashtags: [tag],
      resultsType: "posts",
      resultsLimit: this.resultsLimit,
    });

    const accounts: DiscoveredAccount[] = [];
    for (const post of posts) {
      const username = toStringOrNull(post.ownerUsername);
      if (!username) continue;
      accounts.push({
        handle: username.toLowerCase(),
        instagramUrl: profileUrl(username),
        fullName: toStringOrNull(post.ownerFullName),
        avatarUrl: null,
        followersCount: null,
      });
    }
    return accounts;
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

  private async runActor<T>(actorId: string, input: Record<string, unknown>): Promise<T[]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.callApify<T>(actorId, input, attempt);
      } catch (error) {
        lastError = error;
        logger.warn("discovery.apify.attempt_failed", {
          actorId,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          error: errorMessage(error),
        });
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS); // backoff
      }
    }

    throw new DiscoveryProviderError(`Apify discovery failed after ${MAX_ATTEMPTS} attempts.`, {
      cause: lastError,
    });
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
