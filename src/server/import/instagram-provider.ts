import "server-only";

import { logger } from "@/lib/logger";

import { ApifyInstagramProvider } from "./apify-instagram-provider";
import { InstagramProviderError } from "./errors";
import { MockInstagramProvider } from "./mock-instagram-provider";
import type { InstagramProvider } from "./provider-types";

export type {
  InstagramProvider,
  InstagramProfileRequest,
  RawInstagramProfile,
} from "./provider-types";

let cached: InstagramProvider | null = null;

/**
 * The single place that decides which Instagram source is used. Selection is
 * driven entirely by environment variables so the app switches automatically:
 *
 *   USE_MOCK_PROVIDER=true   -> MockInstagramProvider   (development, default)
 *   USE_MOCK_PROVIDER=false  -> ApifyInstagramProvider  (production, needs APIFY_TOKEN)
 *
 * Defaults to the mock unless USE_MOCK_PROVIDER is explicitly "false", so we
 * never hit a paid API by accident.
 */
export function getInstagramProvider(): InstagramProvider {
  if (cached) return cached;

  const useMock = process.env.USE_MOCK_PROVIDER !== "false";

  if (useMock) {
    cached = new MockInstagramProvider();
  } else {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
      throw new InstagramProviderError("APIFY_TOKEN is required when USE_MOCK_PROVIDER=false.");
    }
    cached = new ApifyInstagramProvider({ token });
  }

  logger.info("import.provider_selected", { provider: cached.name });
  return cached;
}
