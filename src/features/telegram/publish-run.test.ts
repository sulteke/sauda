import { describe, expect, it } from "vitest";

import {
  describeTally,
  EMPTY_TALLY,
  MAX_CONSECUTIVE_FAILURES,
  type PublishRunTally,
  shouldStopForFailures,
  tallyResult,
} from "./publish-run";

const run = (...statuses: (string | null)[]): PublishRunTally =>
  statuses.reduce<PublishRunTally>((t, s) => tallyResult(t, s), EMPTY_TALLY);

describe("tallyResult — counts by outcome", () => {
  /**
   * REGRESSION — every processed boutique was counted as published, so a run
   * in which all nineteen failed told the operator "Published 19".
   */
  it("does not count a failed post as published", () => {
    const t = run("FAILED", "FAILED");
    expect(t.published).toBe(0);
    expect(t.failed).toBe(2);
  });

  it("counts each outcome separately", () => {
    expect(run("PUBLISHED", "FAILED", "SKIPPED", "PUBLISHED")).toMatchObject({
      published: 2,
      failed: 1,
      skipped: 1,
    });
  });

  it("ignores a result with no status — nothing was decided", () => {
    expect(run(null)).toEqual(EMPTY_TALLY);
  });
});

describe("shouldStopForFailures", () => {
  /**
   * REGRESSION — a failed post does not count toward the daily limit, so a run
   * in which every post failed had nothing to stop it, and one press marked
   * nineteen boutiques FAILED in a row for the same expired image links.
   */
  it(`stops after ${MAX_CONSECUTIVE_FAILURES} failures in a row`, () => {
    expect(shouldStopForFailures(run("FAILED", "FAILED"))).toBe(false);
    expect(shouldStopForFailures(run("FAILED", "FAILED", "FAILED"))).toBe(true);
  });

  it("is not tripped by failures that a success separates", () => {
    expect(shouldStopForFailures(run("FAILED", "FAILED", "PUBLISHED", "FAILED", "FAILED"))).toBe(
      false,
    );
  });

  it("treats a skip as neither a failure nor a reset", () => {
    // A location decision is not a fault, but it is no evidence the fault has
    // cleared either.
    const t = run("FAILED", "FAILED", "SKIPPED");
    expect(t.consecutiveFailures).toBe(2);
    expect(shouldStopForFailures(tallyResult(t, "FAILED"))).toBe(true);
  });
});

describe("describeTally", () => {
  it("names only the outcomes that happened", () => {
    expect(describeTally(run("PUBLISHED"))).toBe("Published: 1");
    expect(describeTally(run("PUBLISHED", "FAILED", "SKIPPED"))).toBe(
      "Published: 1 · Failed: 1 · Skipped: 1",
    );
  });
});
