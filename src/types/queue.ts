export type ImportQueueStatus =
  // Two-stage flow: Parse (Apify) then Analyze (Gemini).
  | "PENDING_PARSE"
  | "PARSING"
  | "PENDING_ANALYSIS"
  | "ANALYZING"
  | "READY_FOR_REVIEW"
  | "PARSE_FAILED"
  | "ANALYSIS_FAILED"
  // Terminal quality outcome: below the follower gate, so no AI call was made.
  | "SKIPPED_LOW_FOLLOWERS"
  | "SKIPPED_DUPLICATE"
  // Legacy (pre two-stage split) — retained for rows written before the split.
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

/**
 * One stage of the import, when the operator drives them separately.
 *
 * Left undefined, the queue picks the stage itself — analysis first, then
 * parsing — which is what the single Process Queue button has always done.
 * Naming a stage is for running them apart: scraping costs Apify credit and
 * analysis costs time on whichever model the shop is routed to, and they are
 * worth doing at different moments.
 */
export type QueueStage = "parse" | "analyze";

/** Serializable view of a queued bulk-import URL. */
export interface ImportQueueItemDTO {
  id: string;
  instagramUrl: string;
  status: ImportQueueStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Which project actually analyzed this shop — "local" for the model on this
   * machine, "primary"/"fallback" for a Gemini project. Null until an analysis
   * succeeds.
   *
   * It matters now that size decides where a shop goes: without it the two
   * cannot be told apart, and "the local model handled everything" and "Gemini
   * quietly took half the queue" look identical from the outside.
   */
  analyzedBy: string | null;
}
