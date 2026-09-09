import type { Prisma } from "@prisma/client";

import { type AiCategoryResult, parseAiCategoryResult } from "@/lib/ai-category-provider";
import { EMPTY_ENRICHMENT } from "@/lib/boutique-enrichment";
import type {
  BoutiqueEnrichment,
  BoutiquePost,
  DetectedCategory,
  InstagramBusinessAddress,
  InstagramExternalLink,
  InstagramRelatedProfile,
} from "@/types";

/**
 * Coercions from Prisma `Json` columns to the typed shapes the DTOs expose.
 * Shared by every place that builds a BoutiqueDTO so the mapping stays in one
 * spot. All are defensive: malformed / legacy values degrade to empty defaults
 * rather than throwing.
 */

export function parsePosts(value: Prisma.JsonValue | null | undefined): BoutiquePost[] {
  return Array.isArray(value) ? (value as unknown as BoutiquePost[]) : [];
}

export function parseBusinessAddress(
  value: Prisma.JsonValue | null | undefined,
): InstagramBusinessAddress | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as unknown as InstagramBusinessAddress)
    : null;
}

export function parseExternalLinks(
  value: Prisma.JsonValue | null | undefined,
): InstagramExternalLink[] {
  return Array.isArray(value) ? (value as unknown as InstagramExternalLink[]) : [];
}

export function parseRelatedProfiles(
  value: Prisma.JsonValue | null | undefined,
): InstagramRelatedProfile[] {
  return Array.isArray(value) ? (value as unknown as InstagramRelatedProfile[]) : [];
}

export function parseCategoryScores(
  value: Prisma.JsonValue | null | undefined,
): DetectedCategory[] {
  return Array.isArray(value) ? (value as unknown as DetectedCategory[]) : [];
}

/** Parses stored enrichment, filling any missing keys from the empty template. */
export function parseEnrichment(value: Prisma.JsonValue | null | undefined): BoutiqueEnrichment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_ENRICHMENT;
  return { ...EMPTY_ENRICHMENT, ...(value as unknown as Partial<BoutiqueEnrichment>) };
}

/** Parses the stored raw AI result (reuses the provider's strict parser); null when absent. */
export function parseAiResult(value: Prisma.JsonValue | null | undefined): AiCategoryResult | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return parseAiCategoryResult(value);
}
