import { describe, expect, it } from "vitest";

import { ALMATY } from "@/lib/location";

import type { PublishableBoutique } from "./publication-target";
import { TelegramChannelTarget } from "./telegram-target";

function boutique(over: Partial<PublishableBoutique> = {}): PublishableBoutique {
  return {
    id: "b1",
    name: "Test",
    city: null,
    overrideCity: null,
    categories: [],
    hashtags: [],
    followersCount: null,
    bio: null,
    instagramUrl: null,
    externalUrl: null,
    avatarUrl: null,
    posts: [],
    ...over,
  };
}

const almatyChannel = new TelegramChannelTarget({
  id: "telegram:almaty",
  label: "Telegram — Almaty",
  eligibleCity: ALMATY,
  token: "token",
  chatId: "@chan",
});

describe("TelegramChannelTarget.isEligible", () => {
  it("accepts a boutique detected in the channel's city", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Алматы" }))).toBe(true);
    // Canonicalized, so spelling variants of the same city still match.
    expect(almatyChannel.isEligible(boutique({ city: "Almaty" }))).toBe(true);
  });

  it("rejects another city and an undetected one", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Астана" }))).toBe(false);
    expect(almatyChannel.isEligible(boutique({ city: null }))).toBe(false);
  });

  it("accepts an undetected city once an admin confirmed it via the override", () => {
    expect(almatyChannel.isEligible(boutique({ city: null, overrideCity: "Алматы" }))).toBe(true);
  });

  it("ignores an override for a different city", () => {
    expect(almatyChannel.isEligible(boutique({ city: null, overrideCity: "Астана" }))).toBe(false);
  });

  it("treats the override as additive — it never invalidates a detected match", () => {
    expect(almatyChannel.isEligible(boutique({ city: "Алматы", overrideCity: "Астана" }))).toBe(
      true,
    );
  });
});
