import { describe, expect, it } from "vitest";

import { parseDiscoverySeed } from "./discovery-provider";

describe("parseDiscoverySeed", () => {
  it("accepts a Cyrillic/Kazakh #hashtag (the reported bug)", () => {
    expect(parseDiscoverySeed("#алматыодежда")).toEqual({
      type: "HASHTAG",
      value: "алматыодежда",
    });
    expect(parseDiscoverySeed("#алматыкиім")).toEqual({ type: "HASHTAG", value: "алматыкиім" });
  });

  it("accepts a Latin #hashtag", () => {
    expect(parseDiscoverySeed("#almaty_store2")).toEqual({
      type: "HASHTAG",
      value: "almaty_store2",
    });
  });

  it("strips punctuation/whitespace from a hashtag but keeps letters and digits", () => {
    expect(parseDiscoverySeed("#almaty! одежда")).toEqual({
      type: "HASHTAG",
      value: "almatyодежда",
    });
  });

  it("distinguishes @username, bare username, and URL as PROFILE seeds", () => {
    expect(parseDiscoverySeed("@baraholka_almaty")).toEqual({
      type: "PROFILE",
      value: "baraholka_almaty",
    });
    expect(parseDiscoverySeed("baraholka.almaty")).toEqual({
      type: "PROFILE",
      value: "baraholka.almaty",
    });
    expect(parseDiscoverySeed("https://instagram.com/baraholka_almaty/")).toEqual({
      type: "PROFILE",
      value: "baraholka_almaty",
    });
    expect(parseDiscoverySeed("https://www.instagram.com/foo?hl=en")).toEqual({
      type: "PROFILE",
      value: "foo",
    });
  });

  it("returns null for empty or content-free seeds", () => {
    expect(parseDiscoverySeed("")).toBeNull();
    expect(parseDiscoverySeed("   ")).toBeNull();
    expect(parseDiscoverySeed("#")).toBeNull();
    expect(parseDiscoverySeed("#!!!")).toBeNull();
  });
});
