import "server-only";

import { parseInstagramHandle } from "@/server/import/instagram-url";
import type { DiscoverySeedType } from "@/types";

export interface DiscoverySeed {
  type: DiscoverySeedType;
  value: string;
}

export interface DiscoveredAccount {
  handle: string;
  instagramUrl: string;
}

/** The seam between discovery and any account-discovery source (mock today). */
export interface DiscoveryProvider {
  readonly name: string;
  discover(seed: DiscoverySeed): Promise<DiscoveredAccount[]>;
}

/**
 * Parses a raw admin input into a discovery seed.
 * Accepts a #hashtag, an @handle, an Instagram profile URL, or a bare handle.
 */
export function parseDiscoverySeed(input: string): DiscoverySeed | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("#")) {
    const value = trimmed
      .slice(1)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
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
 * Deterministic, offline discovery source. It fabricates candidate boutique
 * accounts from the seed so the whole discovery → review → queue flow works
 * before a real (e.g. Apify hashtag / related-profiles) source exists. Swap via
 * getDiscoveryProvider() — nothing downstream changes.
 */
export class MockDiscoveryProvider implements DiscoveryProvider {
  readonly name = "mock";

  async discover(seed: DiscoverySeed): Promise<DiscoveredAccount[]> {
    const base = seed.value.replace(/[^a-z0-9]/g, "").slice(0, 20) || "almaty";
    const suffixes =
      seed.type === "HASHTAG"
        ? ["boutique", "store", "shop", "brand", "collection", "atelier", "market", "gallery"]
        : ["official", "store", "shop", "brand", "kz", "almaty", "collection", "boutique"];

    return suffixes.map((suffix) => {
      const handle = `${base}_${suffix}`.slice(0, 30);
      return { handle, instagramUrl: `https://www.instagram.com/${handle}/` };
    });
  }
}

let cached: DiscoveryProvider | null = null;

/**
 * Selects the discovery source. Mock today; a real provider slots in here
 * exactly like ApifyInstagramProvider did for imports — no downstream changes.
 */
export function getDiscoveryProvider(): DiscoveryProvider {
  cached ??= new MockDiscoveryProvider();
  return cached;
}
