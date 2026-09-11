import "server-only";

import type { ImportQueue } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { parseInstagramHandle } from "@/server/import/instagram-url";
import { analyzeInstagramProfile, saveBoutiqueFromImport } from "@/services/import.service";
import type { ImportQueueItemDTO } from "@/types";

function toDTO(row: ImportQueue): ImportQueueItemDTO {
  return {
    id: row.id,
    instagramUrl: row.instagramUrl,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Parses pasted text (one URL per line) and queues the valid Instagram URLs. */
export async function addUrlsToQueue(text: string): Promise<{ added: number; skipped: number }> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const unique = Array.from(new Set(lines));
  const valid = unique.filter((url) => parseInstagramHandle(url) !== null);
  const skipped = unique.length - valid.length;

  if (valid.length > 0) {
    await prisma.importQueue.createMany({
      data: valid.map((instagramUrl) => ({ instagramUrl })),
    });
  }

  return { added: valid.length, skipped };
}

export async function listQueue(): Promise<ImportQueueItemDTO[]> {
  try {
    const rows = await prisma.importQueue.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(toDTO);
  } catch (error) {
    console.error("Failed to list import queue:", error);
    return [];
  }
}

export interface ProcessResult {
  processed: boolean;
  item: ImportQueueItemDTO | null;
  remaining: number;
}

/**
 * Processes the oldest PENDING queue item through the EXISTING import pipeline
 * (analyze → save). Marks COMPLETED, or FAILED with the error. No import logic
 * is duplicated here — it only orchestrates the queue lifecycle.
 */
export async function processNextImport(): Promise<ProcessResult> {
  const next = await prisma.importQueue.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!next) {
    // No PENDING jobs left — this call drained the queue.
    logger.info("queue.finished", { reason: "no-pending-jobs" });
    return { processed: false, item: null, remaining: 0 };
  }

  // Next pending job selected + started.
  logger.info("queue.job_selected", { id: next.id, instagramUrl: next.instagramUrl });
  await prisma.importQueue.update({ where: { id: next.id }, data: { status: "PROCESSING" } });
  const startedAt = Date.now();
  logger.info("queue.job_started", { id: next.id, instagramUrl: next.instagramUrl });

  try {
    const job = await analyzeInstagramProfile({ url: next.instagramUrl, userId: null });
    await saveBoutiqueFromImport(job.id);

    const updated = await prisma.importQueue.update({
      where: { id: next.id },
      data: { status: "COMPLETED", error: null },
    });
    const remaining = await countPending();
    logger.info("queue.job_finished", {
      id: next.id,
      status: "COMPLETED",
      durationMs: Date.now() - startedAt,
      remaining,
    });
    return { processed: true, item: toDTO(updated), remaining };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    const updated = await prisma.importQueue.update({
      where: { id: next.id },
      data: { status: "FAILED", error: message },
    });
    const remaining = await countPending();
    logger.warn("queue.job_finished", {
      id: next.id,
      status: "FAILED",
      durationMs: Date.now() - startedAt,
      remaining,
      error: message,
    });
    return { processed: true, item: toDTO(updated), remaining };
  }
}

async function countPending(): Promise<number> {
  return prisma.importQueue.count({ where: { status: "PENDING" } });
}
