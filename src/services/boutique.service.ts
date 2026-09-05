import "server-only";

import { prisma } from "@/lib/prisma";
import type { BoutiqueDTO } from "@/types";

/** Lists boutiques as serializable DTOs. Returns [] if the DB is unreachable. */
export async function listBoutiques(): Promise<BoutiqueDTO[]> {
  try {
    const rows = await prisma.boutique.findMany({
      orderBy: { createdAt: "desc" },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      city: row.city,
      status: row.status,
      telegramQueued: row.telegramQueued,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  } catch (error) {
    console.error("Failed to list boutiques:", error);
    return [];
  }
}
