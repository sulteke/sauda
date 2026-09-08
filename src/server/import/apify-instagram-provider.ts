import "server-only";

import { logger } from "@/lib/logger";
import type {
  InstagramBusinessAddress,
  InstagramExternalLink,
  InstagramPostChild,
  InstagramPostDimensions,
  InstagramPostMusic,
  InstagramRelatedProfile,
} from "@/types/instagram";

import { InstagramProviderError } from "./errors";
import type {
  InstagramProfileRequest,
  InstagramProvider,
  RawInstagramPost,
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
  followsCount?: number | null;
  postsCount?: number | null;
  profilePicUrl?: string | null;
  profilePicUrlHD?: string | null;
  externalUrl?: string | null;
  externalUrls?: unknown;
  verified?: boolean;
  isVerified?: boolean;
  isBusinessAccount?: boolean;
  private?: boolean;
  isPrivate?: boolean;
  businessAddress?: unknown;
  relatedProfiles?: unknown;
  latestPosts?: unknown;
  posts?: unknown;
  highlightReels?: unknown;
  highlights?: unknown;
  error?: string;
  isRestrictedProfile?: boolean;
  restrictionReason?: string | null;
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
  imageUrl: string | null;
  type: string | null;
  videoUrl: string | null;
  hashtags: string[];
  mentions: string[];
  taggedUsers: string[];
  locationName: string | null;
  locationId: string | null;
  childPosts: InstagramPostChild[];
  musicInfo: InstagramPostMusic | null;
  dimensions: InstagramPostDimensions | null;
  isPinned: boolean;
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

/** Non-empty strings from a raw array (drops null/empty). Used for hashtags/mentions. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toString(entry)).filter((entry): entry is string => entry !== null);
}

/** Extracts tagged usernames from Apify's `taggedUsers` (array of user objects). */
function toUsernameArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toString((entry as Record<string, unknown> | null)?.username))
    .filter((entry): entry is string => entry !== null);
}

/** Maps Apify's snake_case `businessAddress` object to our shape (null if absent). */
function toBusinessAddress(value: unknown): InstagramBusinessAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const address: InstagramBusinessAddress = {
    cityName: toString(item.city_name),
    streetAddress: toString(item.street_address),
    zipCode: toString(item.zip_code),
    latitude: toNumber(item.latitude),
    longitude: toNumber(item.longitude),
  };
  // Only return an address if at least one field carried data.
  return Object.values(address).some((v) => v !== null) ? address : null;
}

/** Maps Apify's `externalUrls` (labeled links) to our shape, dropping urlless entries. */
function toExternalLinks(value: unknown): InstagramExternalLink[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<InstagramExternalLink[]>((acc, entry) => {
    const url = toString((entry as Record<string, unknown> | null)?.url);
    if (url) acc.push({ title: toString((entry as Record<string, unknown>).title), url });
    return acc;
  }, []);
}

/** Maps Apify's `relatedProfiles` (snake_case) to our shape, dropping unnamed entries. */
function toRelatedProfiles(value: unknown): InstagramRelatedProfile[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<InstagramRelatedProfile[]>((acc, entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const username = toString(item.username);
    if (!username) return acc;
    acc.push({
      username,
      fullName: toString(item.full_name),
      isVerified: Boolean(item.is_verified ?? false),
      profilePicUrl: toString(item.profile_pic_url),
    });
    return acc;
  }, []);
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
      recentPosts: recentPosts.slice(0, 6).map(
        (post): RawInstagramPost => ({
          imageUrl: post.imageUrl,
          caption: post.caption,
          likes: post.likesCount,
          comments: post.commentsCount,
          permalink:
            post.url ?? (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : null),
          type: post.type,
          videoUrl: post.videoUrl,
          hashtags: post.hashtags,
          mentions: post.mentions,
          taggedUsers: post.taggedUsers,
          locationName: post.locationName,
          locationId: post.locationId,
          childPosts: post.childPosts,
          musicInfo: post.musicInfo,
          dimensions: post.dimensions,
          isPinned: post.isPinned,
        }),
      ),
      postsCount: toNumber(profile.postsCount),
      followsCount: toNumber(profile.followsCount),
      isBusinessAccount: Boolean(profile.isBusinessAccount ?? false),
      isPrivate: Boolean(profile.private ?? profile.isPrivate ?? false),
      businessAddress: toBusinessAddress(profile.businessAddress),
      externalUrls: toExternalLinks(profile.externalUrls),
      relatedProfiles: toRelatedProfiles(profile.relatedProfiles),
      sourceUrl: request.url,
      fetchedAt: new Date().toISOString(),
      raw: {
        provider: this.name,
        actorId: this.actorId,
        highlights,
        recentPosts,
        postsCount: recentPosts.length,
        isRestrictedProfile: Boolean(profile.isRestrictedProfile ?? false),
        restrictionReason: toString(profile.restrictionReason),
      },
    };
  }

  /** Fetches the profile item from Apify (with retry, timeout and logging). */
  async getProfile(handle: string): Promise<ApifyProfileItem> {
    const items = await this.requestDatasetItems(handle);
    const profile = items[0];

    // A missing username means Apify returned no real profile. A populated
    // profile that also carries an informational `error` (e.g. an age- or
    // region-restricted account) is still a real profile — import it and keep
    // the restriction flags in the raw payload rather than rejecting it.
    if (!profile || !toString(profile.username)) {
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
      const width = toNumber(item.dimensionsWidth);
      const height = toNumber(item.dimensionsHeight);
      const music = (item.musicInfo ?? null) as Record<string, unknown> | null;
      const childSource = Array.isArray(item.childPosts) ? item.childPosts : [];
      return {
        id: toString(item.id),
        shortCode: toString(item.shortCode),
        caption: toString(item.caption),
        likesCount: toNumber(item.likesCount),
        commentsCount: toNumber(item.commentsCount),
        timestamp: toString(item.timestamp),
        url: toString(item.url),
        imageUrl: toString(item.displayUrl) ?? toString(item.imageUrl),
        type: toString(item.type),
        videoUrl: toString(item.videoUrl),
        hashtags: toStringArray(item.hashtags),
        mentions: toStringArray(item.mentions),
        taggedUsers: toUsernameArray(item.taggedUsers),
        locationName: toString(item.locationName),
        locationId: toString(item.locationId),
        childPosts: childSource.map((child): InstagramPostChild => {
          const c = (child ?? {}) as Record<string, unknown>;
          return {
            type: toString(c.type),
            imageUrl: toString(c.displayUrl) ?? toString(c.imageUrl),
            videoUrl: toString(c.videoUrl),
          };
        }),
        musicInfo: music
          ? { artistName: toString(music.artist_name), songName: toString(music.song_name) }
          : null,
        dimensions: width !== null || height !== null ? { width, height } : null,
        isPinned: Boolean(item.isPinned ?? false),
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
