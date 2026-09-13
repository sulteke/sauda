import { describe, expect, it, vi } from "vitest";

import { publishToTargets } from "./publication-engine";
import type { PublicationTarget, PublishableBoutique } from "./publication-target";

function boutique(city: string | null): PublishableBoutique {
  return {
    id: "b1",
    name: "Test",
    city,
    categories: [],
    followersCount: null,
    bio: null,
    instagramUrl: null,
    externalUrl: null,
    avatarUrl: null,
    posts: [],
  };
}

/** A test target eligible for one city, with a mockable publish. */
function target(
  id: string,
  eligibleCity: string,
  publish: () => Promise<void> = () => Promise.resolve(),
): PublicationTarget {
  return {
    id,
    label: id,
    isConfigured: () => true,
    isEligible: (b) => b.city === eligibleCity,
    publish: vi.fn(publish),
  };
}

describe("publishToTargets", () => {
  it("publishes to eligible targets and skips ineligible ones — independently", async () => {
    const almaty = target("telegram:almaty", "Алматы");
    const astana = target("telegram:astana", "Астана");

    const outcomes = await publishToTargets(boutique("Алматы"), [almaty, astana]);

    expect(outcomes).toEqual([
      { targetId: "telegram:almaty", label: "telegram:almaty", status: "PUBLISHED", error: null },
      { targetId: "telegram:astana", label: "telegram:astana", status: "SKIPPED", error: null },
    ]);
    expect(almaty.publish).toHaveBeenCalledTimes(1);
    expect(astana.publish).not.toHaveBeenCalled(); // ineligible → never invoked
  });

  it("records a FAILED outcome (never throws) and still runs the other targets", async () => {
    const failing = target("telegram:almaty", "Алматы", () =>
      Promise.reject(new Error("Telegram down")),
    );
    const other = target("website", "Алматы");

    const outcomes = await publishToTargets(boutique("Алматы"), [failing, other]);

    expect(outcomes[0]).toEqual({
      targetId: "telegram:almaty",
      label: "telegram:almaty",
      status: "FAILED",
      error: "Telegram down",
    });
    // A failure in one target does not stop the next.
    expect(outcomes[1]?.status).toBe("PUBLISHED");
    expect(other.publish).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result when there are no targets", async () => {
    expect(await publishToTargets(boutique("Алматы"), [])).toEqual([]);
  });
});
