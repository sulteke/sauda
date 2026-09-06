export type ImportQueueStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

/** Serializable view of a queued bulk-import URL. */
export interface ImportQueueItemDTO {
  id: string;
  instagramUrl: string;
  status: ImportQueueStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
