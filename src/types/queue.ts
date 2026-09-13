export type ImportQueueStatus =
  // Two-stage flow: Parse (Apify) then Analyze (Gemini).
  | "PENDING_PARSE"
  | "PARSING"
  | "PENDING_ANALYSIS"
  | "ANALYZING"
  | "READY_FOR_REVIEW"
  | "PARSE_FAILED"
  | "ANALYSIS_FAILED"
  // Legacy (pre two-stage split) — retained for rows written before the split.
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

/** Serializable view of a queued bulk-import URL. */
export interface ImportQueueItemDTO {
  id: string;
  instagramUrl: string;
  status: ImportQueueStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
