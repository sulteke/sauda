import { describe, expect, it } from "vitest";

import { canonicalKzCity, isAlmaty, resolveLocation } from "./location";

describe("canonicalKzCity", () => {
  it("canonicalizes Cyrillic, Latin and Kazakh variants to the display name", () => {
    expect(canonicalKzCity("алматы")).toBe("Алматы");
    expect(canonicalKzCity("Almaty")).toBe("Алматы");
    expect(canonicalKzCity("алма-ата")).toBe("Алматы");
    expect(canonicalKzCity("АСТАНА")).toBe("Астана");
    expect(canonicalKzCity("nur-sultan")).toBe("Астана");
    expect(canonicalKzCity("shymkent")).toBe("Шымкент");
  });

  it("tolerates a trailing country segment", () => {
    expect(canonicalKzCity("Almaty, Kazakhstan")).toBe("Алматы");
  });

  it("returns null for unrecognized or empty values", () => {
    expect(canonicalKzCity("Dubai")).toBeNull();
    expect(canonicalKzCity("")).toBeNull();
    expect(canonicalKzCity(null)).toBeNull();
  });
});

describe("isAlmaty", () => {
  it("is true only for Almaty variants", () => {
    expect(isAlmaty("Алматы")).toBe(true);
    expect(isAlmaty("almaty")).toBe(true);
    expect(isAlmaty("Almaty, Kazakhstan")).toBe(true);
    expect(isAlmaty("Астана")).toBe(false);
    expect(isAlmaty("Dubai")).toBe(false);
    expect(isAlmaty(null)).toBe(false);
  });
});

describe("resolveLocation", () => {
  it("prefers the enrichment city and tags KZ cities with the country", () => {
    expect(resolveLocation({ enrichmentCity: "Алматы" })).toEqual({
      city: "Алматы",
      region: null,
      country: "Kazakhstan",
    });
  });

  it("falls back to the AI city when enrichment has none, canonicalizing it", () => {
    expect(resolveLocation({ enrichmentCity: null, aiCity: "Almaty" })).toEqual({
      city: "Алматы",
      region: null,
      country: "Kazakhstan",
    });
  });

  it("enrichment wins over AI when both are present", () => {
    expect(resolveLocation({ enrichmentCity: "Астана", aiCity: "Алматы" }).city).toBe("Астана");
  });

  it("keeps an unrecognized city verbatim with an unknown country (never discarded)", () => {
    expect(resolveLocation({ enrichmentCity: "Dubai" })).toEqual({
      city: "Dubai",
      region: null,
      country: null,
    });
  });

  it("returns all-null when no city signal is available", () => {
    expect(resolveLocation({})).toEqual({ city: null, region: null, country: null });
  });
});
