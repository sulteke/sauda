export type BoutiqueStatus = "DRAFT" | "NEEDS_REVIEW" | "PUBLISHED" | "ARCHIVED";

/** Serializable boutique shape returned to the client (dates as ISO strings). */
export interface BoutiqueDTO {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  city: string | null;
  status: BoutiqueStatus;
  telegramQueued: boolean;
  createdAt: string;
  updatedAt: string;
}
