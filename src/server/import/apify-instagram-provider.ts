import "server-only";

import { logger } from "@/lib/logger";

import { InstagramProviderError } from "./errors";
import type {
  InstagramProfileRequest,
  InstagramProvider,
  RawInstagramProfile,
} from "./provider-types";

// ---------------------------------------------------------------------------
// Apify-specific shapes. These are intentionally NOT exported: no Apify detail
// leaves this module. Everything downstream sees only RawInstagramProfile.
// ---------------------------------------------------------------------------

interface ApifyProfileItem {
  username?: string;
  fullName?: string | null;
  biography?: string | null;
  followersCount?: number | null;
  profilePicUrl?: string | null;
  profilePicUrlHD?: string | null;
  externalUrl?: string | null;
  verified?: boolean;
  isVerified?: boolean;
  businessCategoryName?: string | null;
  category?: string | null;
  latestPosts?: unknown;
  posts?: unknown;
  highlightReels?: unknown;
  highlights?: unknown;
  error?: string;
  [key: string]: unknown;
}

interface InstagramPost {
  id: string | null;
  shortCode: string | null;
  caption: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  timestamp: string | null;
  url: string | null;
}

interface InstagramHighlight {
  id: string | null;
  title: string | null;
  coverUrl: string | null;
}

export interface ApifyInstagramProviderOptions {
  token?: string;
  actorId?: string;
  timeoutMs?: number;
  baseUrl?: string;
}

const DEFAULT_ACTOR = "apify~instagram-profile-scraper";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = "https://api.apify.com";
const MAX_ATTEMPTS = 2; // initial try + one retry

function toString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/**
 * Apify's REST API addresses actors as `username~actorName`. The store UI shows
 * the `username/actorName` (slash) form, and a slash in the path produces an
 * invalid route (HTTP 404). Normalize the slash form to the tilde form so a
 * common configuration mistake can't break requests.
 */
function normalizeActorId(actorId: string): string {
  return actorId.replace(/\//g, "~");
}

/**
 * Production Instagram provider backed by the official Apify REST API. It runs an
 * Instagram scraper actor and normalizes the result into RawInstagramProfile.
 * All Apify knowledge — endpoints, payload shape, parsing — lives here.
 */
export class ApifyInstagramProvider implements InstagramProvider {
  readonly name = "apify";

  private readonly token: string;
  private readonly actorId: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: ApifyInstagramProviderOptions = {}) {
    const envTimeout = Number(process.env.APIFY_TIMEOUT_MS);
    this.token = options.token ?? process.env.APIFY_TOKEN ?? "";
    this.actorId = normalizeActorId(
      options.actorId ?? process.env.APIFY_INSTAGRAM_ACTOR ?? DEFAULT_ACTOR,
    );
    this.timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  /** Interface entry point. Composes the four sub-fetches into one profile. */
  async fetchProfile(request: InstagramProfileRequest): Promise<RawInstagramProfile> {
    const handle = request.handle.trim().toLowerCase();
    if (!handle) {
      throw new InstagramProviderError("An Instagram handle is required.");
    }

    const profile = await this.getProfile(handle);
    const biography = this.getBio(profile);
    const highlights = this.getHighlights(profile);
    const recentPosts = this.getRecentPosts(profile);

    return {
      handle: toString(profile.username) ?? handle,
      fullName: toString(profile.fullName),
      biography,
      profilePicUrl: toString(profile.profilePicUrlHD) ?? toString(profile.profilePicUrl),
      externalUrl: toString(profile.externalUrl),
      followersCount: toNumber(profile.followersCount),
      isVerified: Boolean(profile.verified ?? profile.isVerified ?? false),
      category: toString(profile.businessCategoryName) ?? toString(profile.category),
      sourceUrl: request.url,
      fetchedAt: new Date().toISOString(),
      raw: {
        provider: this.name,
        actorId: this.actorId,
        highlights,
        recentPosts,
        postsCount: recentPosts.length,
      },
    };
  }

  /** Fetches the profile item from Apify (with retry, timeout and logging). */
  async getProfile(handle: string): Promise<ApifyProfileItem> {
    const items = await this.requestDatasetItems(handle);
    const profile = items[0];

    if (!profile || profile.error || !toString(profile.username)) {
      throw new InstagramProviderError(`No Instagram profile found for @${handle}.`);
    }

    return profile;
  }

  /** Parses the biography from a fetched profile item. */
  getBio(profile: ApifyProfileItem): string | null {
    const bio = toString(profile.biography);
    return bio ? bio.trim() : null;
  }

  /** Parses story highlights from a fetched profile item. */
  getHighlights(profile: ApifyProfileItem): InstagramHighlight[] {
    const source = Array.isArray(profile.highlightReels)
      ? profile.highlightReels
      : Array.isArray(profile.highlights)
        ? profile.highlights
        : [];

    return source.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        id: toString(item.id),
        title: toString(item.title),
        coverUrl: toString(item.coverUrl) ?? toString(item.thumbnailUrl),
      };
    });
  }

  /** Parses recent posts from a fetched profile item. */
  getRecentPosts(profile: ApifyProfileItem): InstagramPost[] {
    const source = Array.isArray(profile.latestPosts)
      ? profile.latestPosts
      : Array.isArray(profile.posts)
        ? profile.posts
        : [];

    return source.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        id: toString(item.id),
        shortCode: toString(item.shortCode),
        caption: toString(item.caption),
        likesCount: toNumber(item.likesCount),
        commentsCount: toNumber(item.commentsCount),
        timestamp: toString(item.timestamp),
        url: toString(item.url),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private endpoint(): string {
    return `${this.baseUrl}/v2/acts/${this.actorId}/run-sync-get-dataset-items`;
  }

  private async requestDatasetItems(handle: string): Promise<ApifyProfileItem[]> {
    if (!this.token) {
      throw new InstagramProviderError("APIFY_TOKEN is not configured.");
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.callApify(handle, attempt);
      } catch (error) {
        lastError = error;
        logger.warn("apify.attempt_failed", {
          provider: this.name,
          handle,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          error: errorMessage(error),
        });
      }
    }

    throw new InstagramProviderError(
      `Apify request failed for @${handle} after ${MAX_ATTEMPTS} attempts.`,
      { cause: lastError },
    );
  }

  private async callApify(handle: string, attempt: number): Promise<ApifyProfileItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ usernames: [handle], resultsLimit: 12 }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new InstagramProviderError(`Apify responded with HTTP ${response.status}.`, {
          status: response.status,
        });
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new InstagramProviderError("Apify returned an unexpected payload.");
      }

      logger.info("apify.request_ok", {
        provider: this.name,
        handle,
        attempt,
        durationMs: Date.now() - startedAt,
        items: payload.length,
      });

      return payload as ApifyProfileItem[];
    } catch (error) {
      if (isAbortError(error)) {
        throw new InstagramProviderError(`Apify request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
