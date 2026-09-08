import type { BoutiquePost } from "./boutique";
import type { DetectedCategory, ProductCategory } from "./category";
import type { BoutiqueEnrichment } from "./enrichment";
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
  /** Full scored detection breakdown with match evidence (absent on legacy previews). */
  categoryScores?: DetectedCategory[];
  /** Structured business info derived from the imported data (absent on legacy previews). */
  enrichment?: BoutiqueEnrichment;
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
