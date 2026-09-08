import "server-only";

import type { Boutique, Prisma } from "@prisma/client";

import {
  parseBusinessAddress,
  parseCategoryScores,
  parseEnrichment,
  parseExternalLinks,
  parsePosts,
  parseRelatedProfiles,
} from "@/lib/boutique-json";
import { categoryLabel, resolveProductCategories } from "@/lib/category-engine";
import { prisma } from "@/lib/prisma";
import type { BoutiqueDTO } from "@/types";

// A boutique is public once the admin has approved it in the review pipeline.
const PUBLIC_WHERE: Prisma.BoutiqueWhereInput = {
  status: { in: ["READY_TO_PUBLISH", "PUBLISHED"] },
};

/** Public-facing view of a boutique (dates as ISO strings). Read-only. */
function toPublicDTO(row: Boutique): BoutiqueDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    city: row.city,
    status: row.status,
    telegramQueued: row.telegramQueued,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    category: row.category,
    productCategories: resolveProductCategories(row.productCategories),
    categoryScores: parseCategoryScores(row.categoryScores),
    manualCategoriesAdded: resolveProductCategories(row.manualCategoriesAdded),
    manualCategoriesRemoved: resolveProductCategories(row.manualCategoriesRemoved),
    enrichment: parseEnrichment(row.enrichment),
    followersCount: row.followersCount,
    externalUrl: row.externalUrl,
    instagramHandle: row.instagramHandle,
    instagramUrl: row.instagramUrl,
    telegramError: row.telegramError,
    posts: parsePosts(row.posts),
    isVerified: row.isVerified,
    isBusinessAccount: row.isBusinessAccount,
    isPrivate: row.isPrivate,
    postsCount: row.postsCount,
    followsCount: row.followsCount,
    businessAddress: parseBusinessAddress(row.businessAddress),
    externalUrls: parseExternalLinks(row.externalUrls),
    relatedProfiles: parseRelatedProfiles(row.relatedProfiles),
    lastImportedAt: row.createdAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findPublic(
  args: Omit<Prisma.BoutiqueFindManyArgs, "where"> & { where?: Prisma.BoutiqueWhereInput },
): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({
      ...args,
      where: args.where ? { AND: [PUBLIC_WHERE, args.where] } : PUBLIC_WHERE,
    });
    return rows.map(toPublicDTO);
  } catch (error) {
    console.error("Public boutique query failed:", error);
    return [];
  }
}

export function listFeaturedBoutiques(limit = 6): Promise<BoutiqueDTO[]> {
  return findPublic({ orderBy: [{ followersCount: "desc" }, { createdAt: "desc" }], take: limit });
}

export function listRecentBoutiques(limit = 8): Promise<BoutiqueDTO[]> {
  return findPublic({ orderBy: { createdAt: "desc" }, take: limit });
}

export async function getPublicBoutiqueBySlug(slug: string): Promise<BoutiqueDTO | null> {
  try {
    const row = await prisma.boutique.findFirst({ where: { AND: [PUBLIC_WHERE, { slug }] } });
    return row ? toPublicDTO(row) : null;
  } catch (error) {
    console.error("Public boutique lookup failed:", error);
    return null;
  }
}

/** Searches public boutiques by name or Instagram handle (case-insensitive). */
export function searchPublicBoutiques(query: string): Promise<BoutiqueDTO[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  const handle = q.replace(/^@/, "");
  return findPublic({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { instagramHandle: { contains: handle, mode: "insensitive" } },
      ],
    },
    orderBy: { followersCount: "desc" },
    take: 50,
  });
}

export interface CategorySummary {
  name: string;
  slug: string;
  count: number;
}

/**
 * Distinct product categories across public boutiques, with counts. Aggregated
 * over the multi-valued `productCategories` (a boutique can appear under several
 * categories). Slug = category id; name = its display label.
 */
export async function listCategories(): Promise<CategorySummary[]> {
  try {
    const rows = await prisma.boutique.findMany({
      where: PUBLIC_WHERE,
      select: { productCategories: true },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const id of row.productCategories) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([id, count]) => ({ name: categoryLabel(id) ?? id, slug: id, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } catch (error) {
    console.error("Public category query failed:", error);
    return [];
  }
}

/** Resolves a category slug (its id) to its boutiques. */
export async function getCategoryBySlug(
  slug: string,
): Promise<{ category: CategorySummary; boutiques: BoutiqueDTO[] } | null> {
  const label = categoryLabel(slug);
  if (!label) return null;

  const boutiques = await findPublic({
    where: { productCategories: { has: slug } },
    orderBy: [{ followersCount: "desc" }, { createdAt: "desc" }],
  });
  if (boutiques.length === 0) return null;

  return { category: { name: label, slug, count: boutiques.length }, boutiques };
}
