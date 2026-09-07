import "server-only";

import type { Boutique, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { BoutiqueDTO, BoutiquePost } from "@/types";
import { slugify } from "@/utils/format";

// A boutique is public once the admin has approved it in the review pipeline.
const PUBLIC_WHERE: Prisma.BoutiqueWhereInput = {
  status: { in: ["READY_TO_PUBLISH", "PUBLISHED"] },
};

function parsePosts(value: Prisma.JsonValue | null): BoutiquePost[] {
  return Array.isArray(value) ? (value as unknown as BoutiquePost[]) : [];
}

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
    followersCount: row.followersCount,
    externalUrl: row.externalUrl,
    instagramHandle: row.instagramHandle,
    instagramUrl: row.instagramUrl,
    telegramError: row.telegramError,
    posts: parsePosts(row.posts),
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

/** Distinct categories across public boutiques, with counts. */
export async function listCategories(): Promise<CategorySummary[]> {
  try {
    const grouped = await prisma.boutique.groupBy({
      by: ["category"],
      where: { AND: [PUBLIC_WHERE, { category: { not: null } }] },
      _count: { _all: true },
    });
    return grouped
      .filter((group): group is typeof group & { category: string } => Boolean(group.category))
      .map((group) => ({
        name: group.category,
        slug: slugify(group.category),
        count: group._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  } catch (error) {
    console.error("Public category query failed:", error);
    return [];
  }
}

/** Resolves a category slug to its boutiques (slug derived from the category name). */
export async function getCategoryBySlug(
  slug: string,
): Promise<{ category: CategorySummary; boutiques: BoutiqueDTO[] } | null> {
  const categories = await listCategories();
  const category = categories.find((entry) => entry.slug === slug);
  if (!category) return null;

  const boutiques = await findPublic({
    where: { category: category.name },
    orderBy: [{ followersCount: "desc" }, { createdAt: "desc" }],
  });
  return { category, boutiques };
}
