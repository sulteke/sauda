import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApifyDiscoveryProvider } from "./apify-discovery-provider";

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

function createProvider() {
  return new ApifyDiscoveryProvider({ token: "test-token", timeoutMs: 50, baseUrl: "https://api.apify.test" });
}

let fetchMock: ReturnType<typeof vi.fn>;

describe("ApifyDiscoveryProvider", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs a HASHTAG seed against apify~instagram-hashtag-scraper with the tag", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ ownerUsername: "shop_one" }, { ownerUsername: "shop_two" }]),
    );

    const accounts = await createProvider().discover({ type: "HASHTAG", value: "алматыодежда" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/acts/apify~instagram-hashtag-scraper/");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.hashtags).toEqual(["алматыодежда"]); // Cyrillic tag reaches the actor
    expect(body.resultsType).toBe("posts");

    expect(accounts.map((a) => a.handle)).toEqual(["shop_one", "shop_two"]);
  });

  it("runs a PROFILE seed against the profile actor and returns related accounts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ username: "seeduser", relatedProfiles: [{ username: "Rel1" }, { username: "rel2" }] }]),
    );

    const accounts = await createProvider().discover({ type: "PROFILE", value: "seeduser" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/acts/apify~instagram-profile-scraper/");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.usernames).toEqual(["seeduser"]);

    // Related accounts returned (lowercased), excluding the seed itself.
    expect(accounts.map((a) => a.handle)).toEqual(["rel1", "rel2"]);
  });
});
