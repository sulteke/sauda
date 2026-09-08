import type { BoutiquePost } from "./boutique";
import type { ProductCategory } from "./category";
import type {
  InstagramBusinessAddress,
  InstagramExternalLink,
  InstagramRelatedProfile,
} from "./instagram";

export type ImportSource = "INSTAGRAM";

export type ImportStatus = "PENDING" | "PROCESSING" | "READY_FOR_REVIEW" | "COMPLETED" | "FAILED";

/** Normalized boutique draft produced by the import pipeline and shown in the preview. */
export interface BoutiquePreview {
  name: string;
  slug: string;
  description: string | null;
  instagramHandle: string;
  instagramUrl: string;
  avatarUrl: string | null;
  externalUrl: string | null;
  followersCount: number | null;
  isVerified: boolean;
  /** Primary detected product category label (replaces Instagram's own category). */
  category: string | null;
  /** All auto-detected product categories, richest-first (absent on legacy previews). */
  productCategories?: ProductCategory[];
  city: string | null;
  recentPosts: BoutiquePost[];
  // Richer profile metadata (optional: older preview payloads predate these).
  isBusinessAccount?: boolean;
  isPrivate?: boolean;
  postsCount?: number | null;
  followsCount?: number | null;
  businessAddress?: InstagramBusinessAddress | null;
  externalUrls?: InstagramExternalLink[];
  relatedProfiles?: InstagramRelatedProfile[];
}

/** Serializable view of an import job returned to the client. */
export interface ImportJobDTO {
  id: string;
  source: ImportSource;
  sourceUrl: string;
  handle: string | null;
  status: ImportStatus;
  preview: BoutiquePreview | null;
  error: string | null;
  boutiqueId: string | null;
  createdAt: string;
  updatedAt: string;
}
