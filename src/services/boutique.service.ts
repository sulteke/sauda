import "server-only";

import { Prisma, type Boutique } from "@prisma/client";

import type { BoutiqueInput, BoutiqueUpdate } from "@/features/boutiques/schemas";
import { prisma } from "@/lib/prisma";
import type { BoutiqueDTO, BoutiquePost, BoutiqueStatus } from "@/types";
import { slugify } from "@/utils/format";

function parsePosts(value: Prisma.JsonValue | null): BoutiquePost[] {
  return Array.isArray(value) ? (value as unknown as BoutiquePost[]) : [];
}

function toDTO(row: Boutique, lastImportedAt: string | null = null): BoutiqueDTO {
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
    lastImportedAt: lastImportedAt ?? row.createdAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lists boutiques as serializable DTOs. Returns [] if the DB is unreachable. */
export async function listBoutiques(): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((row) => toDTO(row));
  } catch (error) {
    console.error("Failed to list boutiques:", error);
    return [];
  }
}

/** Boutiques awaiting a publish decision (imported, not yet approved/rejected). */
export async function listReviewQueue(): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({
      where: { status: { in: ["DRAFT", "NEEDS_REVIEW"] } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => toDTO(row));
  } catch (error) {
    console.error("Failed to list review queue:", error);
    return [];
  }
}

/** Boutiques in any of the given statuses (used by the Telegram board). */
export async function listBoutiquesByStatus(statuses: BoutiqueStatus[]): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({
      where: { status: { in: statuses } },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => toDTO(row));
  } catch (error) {
    console.error("Failed to list boutiques by status:", error);
    return [];
  }
}

export async function getBoutiqueById(id: string): Promise<BoutiqueDTO | null> {
  const row = await prisma.boutique.findUnique({
    where: { id },
    include: {
      importJobs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  if (!row) return null;
  const lastImportedAt = row.importJobs[0]?.createdAt.toISOString() ?? null;
  return toDTO(row, lastImportedAt);
}

export async function createBoutique(input: BoutiqueInput): Promise<BoutiqueDTO> {
  const slug = input.slug && input.slug.length > 0 ? slugify(input.slug) : slugify(input.name);

  const row = await prisma.boutique.create({
    data: {
      name: input.name,
      slug,
      city: input.city || null,
      description: input.description || null,
      status: input.status,
      telegramQueued: input.telegramQueued,
    },
  });

  return toDTO(row);
}

export async function updateBoutique(id: string, input: BoutiqueUpdate): Promise<BoutiqueDTO> {
  const data: Prisma.BoutiqueUpdateInput = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.city !== undefined) data.city = input.city || null;
  if (input.description !== undefined) data.description = input.description || null;
  if (input.status !== undefined) data.status = input.status;
  if (input.telegramQueued !== undefined) data.telegramQueued = input.telegramQueued;

  if (input.slug !== undefined) {
    const base = input.slug && input.slug.length > 0 ? input.slug : (input.name ?? "");
    if (base) data.slug = slugify(base);
  }

  const row = await prisma.boutique.update({ where: { id }, data });
  return toDTO(row);
}

export async function deleteBoutique(id: string): Promise<void> {
  await prisma.boutique.delete({ where: { id } });
}

/** Type guard for a Prisma "record not found" error (P2025). */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/** Type guard for a Prisma unique-constraint violation (P2002). */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
