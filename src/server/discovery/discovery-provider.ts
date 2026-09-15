import "server-only";

import { parseInstagramHandle } from "@/server/import/instagram-url";
import type { DiscoverySeedType } from "@/types";

import { ApifyDiscoveryProvider } from "./apify-discovery-provider";
import { DiscoveryProviderError } from "./errors";

export interface DiscoverySeed {
  type: DiscoverySeedType;
  value: string;
}

/** A normalized discovered account. Persistence only uses handle + instagramUrl. */
export interface DiscoveredAccount {
  handle: string;
  instagramUrl: string;
  fullName: string | null;
  avatarUrl: string | null;
  followersCount: number | null;
}

/** How many genuinely-new accounts a hashtag discovery run aims to collect.
 *  Overridable via APIFY_DISCOVERY_TARGET_NEW_ACCOUNTS. */
export const DEFAULT_TARGET_NEW_ACCOUNTS = 50;
/** Page size used when walking hashtag results and filtering against the DB. */
export const DEFAULT_DISCOVERY_PAGE_SIZE = 10;

/**
 * Options threaded into a discovery run. The provider stays DB-agnostic: the
 * service injects `isKnownHandles` (which queries Prisma) so the paginator can
 * skip accounts already imported or already discovered, and keep fetching pages
 * until it has collected `targetNewCount` genuinely-new accounts.
 */
export interface DiscoverOptions {
  /**
   * Given a batch of lowercase handles, returns the subset that already exists
   * in the database (as a boutique or an existing discovery candidate). Absent
   * in contexts with no DB (then nothing is treated as known).
   */
  isKnownHandles?: (handles: string[]) => Promise<Set<string>>;
  /** Stop collecting once this many NEW accounts are found. Default 10. */
  targetNewCount?: number;
  /** Accounts examined per page while walking results. Default 10. */
  pageSize?: number;
}

/** The seam between discovery and any account-discovery source. */
export interface DiscoveryProvider {
  readonly name: string;
  discover(seed: DiscoverySeed, options?: DiscoverOptions): Promise<DiscoveredAccount[]>;
}

/**
 * Parses a raw admin input into a discovery seed.
 * Accepts a #hashtag, an @handle, an Instagram profile URL, or a bare handle.
 */
export function parseDiscoverySeed(input: string): DiscoverySeed | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("#")) {
    // Instagram hashtags support Unicode (Cyrillic, Kazakh, …), so keep any
    // letter/number plus underscore — stripping to ASCII would turn
    // "#алматыодежда" into "" and wrongly reject it.
    const value = trimmed
      .slice(1)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]/gu, "");
    return value ? { type: "HASHTAG", value } : null;
  }

  if (trimmed.startsWith("@")) {
    const value = trimmed
      .slice(1)
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, "");
    return value ? { type: "PROFILE", value } : null;
  }

  const fromUrl = parseInstagramHandle(trimmed);
  if (fromUrl) return { type: "PROFILE", value: fromUrl };

  const bare = trimmed.toLowerCase();
  if (/^[a-z0-9._]{1,30}$/.test(bare)) return { type: "PROFILE", value: bare };

  return null;
}

/**
 * Deterministic, offline discovery source used in development (USE_MOCK_PROVIDER
 * !== "false"). Kept as the dev fallback; production uses ApifyDiscoveryProvider.
 */
export class MockDiscoveryProvider implements DiscoveryProvider {
  readonly name = "mock";

  async discover(seed: DiscoverySeed, options: DiscoverOptions = {}): Promise<DiscoveredAccount[]> {
    const base = seed.value.replace(/[^a-z0-9]/g, "").slice(0, 20) || "almaty";
    const suffixes =
      seed.type === "HASHTAG"
        ? ["boutique", "store", "shop", "brand", "collection", "atelier", "market", "gallery"]
        : ["official", "store", "shop", "brand", "kz", "almaty", "collection", "boutique"];

    const accounts = suffixes.map((suffix) => {
      const handle = `${base}_${suffix}`.slice(0, 30);
      return {
        handle,
        instagramUrl: `https://www.instagram.com/${handle}/`,
        fullName: null,
        avatarUrl: null,
        followersCount: null,
      };
    });

    // Mirror production semantics: drop accounts already in the DB and cap to the
    // target count, so dev behaves like the paginated Apify provider.
    const targetNew = options.targetNewCount ?? DEFAULT_TARGET_NEW_ACCOUNTS;
    const known = options.isKnownHandles
      ? await options.isKnownHandles(accounts.map((account) => account.handle))
      : new Set<string>();
    return accounts.filter((account) => !known.has(account.handle)).slice(0, targetNew);
  }
}

let cached: DiscoveryProvider | null = null;

/**
 * Selects the discovery source by environment, mirroring getInstagramProvider:
 *   USE_MOCK_PROVIDER=true  -> MockDiscoveryProvider  (dev, default)
 *   USE_MOCK_PROVIDER=false -> ApifyDiscoveryProvider (production, needs APIFY_TOKEN)
 */
export function getDiscoveryProvider(): DiscoveryProvider {
  if (cached) return cached;

  const useMock = process.env.USE_MOCK_PROVIDER !== "false";

  if (useMock) {
    cached = new MockDiscoveryProvider();
  } else {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
      throw new DiscoveryProviderError("APIFY_TOKEN is required when USE_MOCK_PROVIDER=false.");
    }
    cached = new ApifyDiscoveryProvider({ token });
  }

  return cached;
}
