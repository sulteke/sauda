import "server-only";

import { prisma } from "@/lib/prisma";
import { ImportValidationError } from "@/server/import/errors";
import { runDiscovery, runPersist, toImportJobDTO } from "@/server/import/import-pipeline";
import { parseInstagramHandle } from "@/server/import/instagram-url";
import type { ImportJobDTO } from "@/types";

/**
 * Public import API. The route handlers call these; all orchestration and status
 * transitions live in the pipeline. Runs inline today; the same calls can be
 * enqueued for a worker without changing the surface.
 */

export async function analyzeInstagramProfile(input: {
  url: string;
  userId?: string | null;
}): Promise<ImportJobDTO> {
  const handle = parseInstagramHandle(input.url);
  if (!handle) {
    throw new ImportValidationError(
      "Enter a valid Instagram profile URL (e.g. https://instagram.com/almaty.store).",
    );
  }

  const created = await prisma.importJob.create({
    data: {
      source: "INSTAGRAM",
      sourceUrl: input.url.trim(),
      handle,
      status: "PENDING",
      createdBy: input.userId ?? null,
    },
  });

  const processed = await runDiscovery(created.id);
  return toImportJobDTO(processed);
}

export async function saveBoutiqueFromImport(
  jobId: string,
): Promise<{ job: ImportJobDTO; boutiqueId: string }> {
  const { job, boutiqueId } = await runPersist(jobId);
  return { job: toImportJobDTO(job), boutiqueId };
}

export async function getImportJob(jobId: string): Promise<ImportJobDTO | null> {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  return job ? toImportJobDTO(job) : null;
}
