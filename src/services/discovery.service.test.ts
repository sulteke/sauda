import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoverOptions, DiscoverySeed } from "@/server/discovery/discovery-provider";

const { boutiqueFindMany, candidateFindMany, candidateCreateMany } = vi.hoisted(() => ({
  boutiqueFindMany: vi.fn(),
  candidateFindMany: vi.fn(),
  candidateCreateMany: vi.fn(),
}));

const { getDiscoveryProvider } = vi.hoisted(() => ({ getDiscoveryProvider: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    boutique: { findMany: boutiqueFindMany },
    discoveryCandidate: { findMany: candidateFindMany, createMany: candidateCreateMany },
  },
}));

// Keep the real seed parser / constants; only swap the provider factory.
vi.mock("@/server/discovery/discovery-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/discovery/discovery-provider")>();
  return { ...actual, getDiscoveryProvider };
});

import { runDiscovery } from "./discovery.service";

describe("runDiscovery — new-account filtering", () => {
  beforeEach(() => {
    boutiqueFindMany.mockReset();
    candidateFindMany.mockReset();
    candidateCreateMany.mockReset();
    getDiscoveryProvider.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("passes a DB-backed isKnownHandles that unions boutiques + candidates, and a target of 10", async () => {
    // "imported_boutique" is an existing boutique; "old_candidate" is an existing candidate.
    boutiqueFindMany.mockResolvedValue([{ instagramHandle: "imported_boutique" }]);
    candidateFindMany.mockResolvedValue([{ handle: "old_candidate" }]);
    candidateCreateMany.mockResolvedValue({ count: 1 });

    let capturedOptions: DiscoverOptions | undefined;
    getDiscoveryProvider.mockReturnValue({
      name: "fake",
      async discover(_seed: DiscoverySeed, options: DiscoverOptions = {}) {
        capturedOptions = options;
        // Exercise the injected checker with a mixed batch.
        const known = options.isKnownHandles
          ? await options.isKnownHandles(["imported_boutique", "old_candidate", "brand_new"])
          : new Set<string>();
        expect(known).toEqual(new Set(["imported_boutique", "old_candidate"]));
        return [
          {
            handle: "brand_new",
            instagramUrl: "https://www.instagram.com/brand_new/",
            fullName: null,
            avatarUrl: null,
            followersCount: null,
          },
        ];
      },
    });

    const result = await runDiscovery("#almatyshop");

    expect(capturedOptions?.targetNewCount).toBe(10);
    // The checker queried BOTH tables with the batch of handles.
    expect(boutiqueFindMany).toHaveBeenCalledWith({
      where: { instagramHandle: { in: ["imported_boutique", "old_candidate", "brand_new"] } },
      select: { instagramHandle: true },
    });
    expect(candidateFindMany).toHaveBeenCalledWith({
      where: { handle: { in: ["imported_boutique", "old_candidate", "brand_new"] } },
      select: { handle: true },
    });
    // Only the new account is persisted.
    expect(candidateCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result).toMatchObject({ seedType: "HASHTAG", seedValue: "almatyshop", found: 1, added: 1 });
  });
});
