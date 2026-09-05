import "server-only";

import { BoutiqueStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { DashboardStats } from "@/types";

/**
 * Live dashboard counters. These are real aggregate queries — with an empty
 * database they simply return zeros (no seeded/mock data).
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  try {
    const [totalBoutiques, needReview, published, telegramQueue] = await Promise.all([
      prisma.boutique.count(),
      prisma.boutique.count({ where: { status: BoutiqueStatus.NEEDS_REVIEW } }),
      prisma.boutique.count({ where: { status: BoutiqueStatus.PUBLISHED } }),
      prisma.boutique.count({ where: { telegramQueued: true } }),
    ]);

    return { totalBoutiques, needReview, published, telegramQueue };
  } catch (error) {
    // The database may not be reachable yet (before credentials are set).
    console.error("Failed to load dashboard stats:", error);
    return { totalBoutiques: 0, needReview: 0, published: 0, telegramQueue: 0 };
  }
}
