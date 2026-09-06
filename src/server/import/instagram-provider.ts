import "server-only";

import { MockInstagramProvider } from "./mock-instagram-provider";
import type { InstagramProvider } from "./provider-types";

export type {
  InstagramProvider,
  InstagramProfileRequest,
  RawInstagramProfile,
} from "./provider-types";

let cached: InstagramProvider | null = null;

/**
 * The single place that decides which Instagram source is used. Today it always
 * returns the mock. When a real provider lands (Apify, Scraping Browser, etc.)
 * it plugs in here — env-gated — and no caller changes:
 *
 *   return process.env.INSTAGRAM_PROVIDER === "apify"
 *     ? new ApifyInstagramProvider()
 *     : new MockInstagramProvider();
 */
export function getInstagramProvider(): InstagramProvider {
  if (!cached) {
    cached = new MockInstagramProvider();
  }
  return cached;
}
