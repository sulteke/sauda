/**
 * The bookkeeping for one Publish Queue run, kept out of the component so the
 * decisions — what counts as published, when to give up — can be tested
 * without a browser.
 */

/**
 * Failures in a row after which the run stops by itself.
 *
 * A failed post does not count toward the daily limit, so nothing else stops a
 * run in which every post fails: when stored Instagram image links had expired,
 * one press walked the whole queue and marked nineteen boutiques FAILED, one
 * after another, for the same reason. Three in a row is past bad luck and well
 * short of the queue.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface PublishRunTally {
  published: number;
  failed: number;
  /** Not a failure: the publisher decided the boutique is not for this channel. */
  skipped: number;
  consecutiveFailures: number;
}

export const EMPTY_TALLY: PublishRunTally = {
  published: 0,
  failed: 0,
  skipped: 0,
  consecutiveFailures: 0,
};

/**
 * Folds one publish result into the tally.
 *
 * Counts by OUTCOME. Counting every processed boutique as published told the
 * operator "Published 19" for a run in which all nineteen had failed.
 */
export function tallyResult(tally: PublishRunTally, status: string | null): PublishRunTally {
  switch (status) {
    case "PUBLISHED":
      return { ...tally, published: tally.published + 1, consecutiveFailures: 0 };
    case "FAILED":
      return {
        ...tally,
        failed: tally.failed + 1,
        consecutiveFailures: tally.consecutiveFailures + 1,
      };
    case "SKIPPED":
      // A location decision, not a fault — it neither counts as a failure nor
      // breaks a streak of them.
      return { ...tally, skipped: tally.skipped + 1 };
    default:
      return tally;
  }
}

/** True once the run has failed enough times in a row to stop by itself. */
export function shouldStopForFailures(tally: PublishRunTally): boolean {
  return tally.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

/** One line for the toast, naming every outcome that happened. */
export function describeTally(tally: PublishRunTally): string {
  const parts = [`Published: ${tally.published}`];
  if (tally.failed > 0) parts.push(`Failed: ${tally.failed}`);
  if (tally.skipped > 0) parts.push(`Skipped: ${tally.skipped}`);
  return parts.join(" · ");
}
