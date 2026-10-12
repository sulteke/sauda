import { describe, expect, it } from "vitest";

import { IMAGES_EXPIRED, IMAGES_UNREACHABLE } from "@/lib/instagram-image";

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

describe("dead images — a fault of one boutique, not of the channel", () => {
  const expired = (t: PublishRunTally) => tallyResult(t, "FAILED", IMAGES_EXPIRED);

  /**
   * REGRESSION — three retried boutiques whose links had all expired stopped
   * the run, and the nine boutiques with live images queued behind them were
   * never sent.
   */
  it("does not stop the run, however many there are", () => {
    const t = [1, 2, 3, 4, 5].reduce<PublishRunTally>((acc) => expired(acc), EMPTY_TALLY);
    expect(t.consecutiveFailures).toBe(0);
    expect(shouldStopForFailures(t)).toBe(false);
  });

  it("still counts them as failed, and separately", () => {
    const t = expired(expired(EMPTY_TALLY));
    expect(t.failed).toBe(2);
    expect(t.deadImages).toBe(2);
  });

  it("does not hide a streak of REAL failures around them", () => {
    const t = expired(run("FAILED", "FAILED"));
    expect(t.consecutiveFailures).toBe(2);
    expect(shouldStopForFailures(tallyResult(t, "FAILED"))).toBe(true);
  });

  it("treats links Telegram cannot reach the same way as expired ones", () => {
    const t = tallyResult(
      tallyResult(EMPTY_TALLY, "FAILED", IMAGES_UNREACHABLE),
      "FAILED",
      IMAGES_UNREACHABLE,
    );
    expect(t.consecutiveFailures).toBe(0);
    expect(t.deadImages).toBe(2);
  });

  it("tells the operator what to do about them", () => {
    expect(describeTally(expired(run("PUBLISHED")))).toBe(
      "Published: 1 · Failed: 1 (1 with dead images — re-parse them)",
    );
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
