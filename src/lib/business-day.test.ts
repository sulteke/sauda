import { afterEach, describe, expect, it } from "vitest";

import { businessDayKey, businessTimeZone, DEFAULT_BUSINESS_TIMEZONE, startOfBusinessDay } from "./business-day";

const original = process.env.BUSINESS_TIMEZONE;

afterEach(() => {
  if (original === undefined) delete process.env.BUSINESS_TIMEZONE;
  else process.env.BUSINESS_TIMEZONE = original;
});

describe("businessTimeZone", () => {
  it("defaults to Asia/Almaty", () => {
    delete process.env.BUSINESS_TIMEZONE;
    expect(businessTimeZone()).toBe("Asia/Almaty");
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe("Asia/Almaty");
  });

  it("honors BUSINESS_TIMEZONE", () => {
    process.env.BUSINESS_TIMEZONE = "Europe/Berlin";
    expect(businessTimeZone()).toBe("Europe/Berlin");
  });

  it("ignores a blank override", () => {
    process.env.BUSINESS_TIMEZONE = "   ";
    expect(businessTimeZone()).toBe("Asia/Almaty");
  });
});

describe("startOfBusinessDay (Asia/Almaty, UTC+5)", () => {
  it("returns the UTC instant of local midnight", () => {
    // 2026-09-20 09:30 Almaty = 04:30 UTC. The day began at 2026-09-19T19:00Z.
    const start = startOfBusinessDay(new Date("2026-09-20T04:30:00.000Z"));
    expect(start.toISOString()).toBe("2026-09-19T19:00:00.000Z");
  });

  it("rolls over at local midnight, NOT at UTC midnight", () => {
    // 22:00 UTC is already 03:00 the NEXT day in Almaty.
    const beforeUtcMidnight = startOfBusinessDay(new Date("2026-09-20T22:00:00.000Z"));
    const afterUtcMidnight = startOfBusinessDay(new Date("2026-09-21T01:00:00.000Z"));
    // Both are the same Almaty day (2026-09-21), despite straddling UTC midnight.
    expect(beforeUtcMidnight.toISOString()).toBe("2026-09-20T19:00:00.000Z");
    expect(afterUtcMidnight.toISOString()).toBe("2026-09-20T19:00:00.000Z");
  });

  it("starts a new business day at 19:00 UTC", () => {
    const lastMoment = startOfBusinessDay(new Date("2026-09-20T18:59:59.999Z"));
    const firstMoment = startOfBusinessDay(new Date("2026-09-20T19:00:00.000Z"));
    expect(lastMoment.toISOString()).toBe("2026-09-19T19:00:00.000Z");
    expect(firstMoment.toISOString()).toBe("2026-09-20T19:00:00.000Z");
    expect(firstMoment.getTime()).toBeGreaterThan(lastMoment.getTime());
  });

  it("is stable for every instant within one business day", () => {
    const day = ["2026-09-20T19:00:00.000Z", "2026-09-21T06:00:00.000Z", "2026-09-21T18:59:00.000Z"];
    const starts = day.map((iso) => startOfBusinessDay(new Date(iso)).toISOString());
    expect(new Set(starts).size).toBe(1);
  });

  it("handles a DST zone correctly when configured", () => {
    // Europe/Berlin is UTC+2 in summer: the day starts at 22:00 UTC the day before.
    const start = startOfBusinessDay(new Date("2026-07-15T10:00:00.000Z"), "Europe/Berlin");
    expect(start.toISOString()).toBe("2026-07-14T22:00:00.000Z");
  });
});

describe("businessDayKey", () => {
  it("names the Almaty calendar day, not the UTC one", () => {
    expect(businessDayKey(new Date("2026-09-20T22:00:00.000Z"))).toBe("2026-09-21");
    expect(businessDayKey(new Date("2026-09-20T18:00:00.000Z"))).toBe("2026-09-20");
  });
});
