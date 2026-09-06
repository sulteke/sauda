import "server-only";

import { Prisma, type Boutique } from "@prisma/client";

import type { BoutiqueInput, BoutiqueUpdate } from "@/features/boutiques/schemas";
import { prisma } from "@/lib/prisma";
import type { BoutiqueDTO } from "@/types";
import { slugify } from "@/utils/format";

function toDTO(row: Boutique): BoutiqueDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    city: row.city,
    status: row.status,
    telegramQueued: row.telegramQueued,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Lists boutiques as serializable DTOs. Returns [] if the DB is unreachable. */
export async function listBoutiques(): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(toDTO);
  } catch (error) {
    console.error("Failed to list boutiques:", error);
    return [];
  }
}

export async function getBoutiqueById(id: string): Promise<BoutiqueDTO | null> {
  const row = await prisma.boutique.findUnique({ where: { id } });
  return row ? toDTO(row) : null;
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
