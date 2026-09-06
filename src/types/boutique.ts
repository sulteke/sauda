export type BoutiqueStatus = "DRAFT" | "NEEDS_REVIEW" | "PUBLISHED" | "ARCHIVED";

/** A single Instagram post captured during import (snapshot, not re-scraped). */
export interface BoutiquePost {
  imageUrl: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
}

/** Serializable boutique shape returned to the client (dates as ISO strings). */
export interface BoutiqueDTO {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  city: string | null;
  status: BoutiqueStatus;
  telegramQueued: boolean;
  avatarUrl: string | null;
  bio: string | null;
  category: string | null;
  followersCount: number | null;
  externalUrl: string | null;
  instagramHandle: string | null;
  instagramUrl: string | null;
  posts: BoutiquePost[];
  lastImportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
