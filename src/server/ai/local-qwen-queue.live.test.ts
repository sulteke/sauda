import { describe, expect, it, vi } from "vitest";

/**
 * LOCAL ONLY — the real queue service, the real provider pool and the real
 * local model, over the LOCAL database.
 *
 * This is the one test that exercises what pressing "Process Queue" in the app
 * actually does: `processNextImport()` picks up the pending batch, sends ONE
 * request to the model on 127.0.0.1, and writes the answers back. Everything
 * the mocked suites stub out is real here except the shops, which are seeded
 * fixtures in a local Postgres.
 *
 * It caught the regression it was written for: the pool capped every provider
 * at a Gemini-shaped 28s, so a local call that needs ~77s was aborted every
 * time and the item became ANALYSIS_FAILED.
 *
 * Run it with LM Studio up and the local queue seeded:
 *   DATABASE_URL="postgresql://<user>@127.0.0.1:5432/sauda_local" \
 *     LOCAL_QUEUE_E2E=true LOCAL_AI_ENABLED=true LOCAL_AI_ONLY=true \
 *     ANALYSIS_BATCH_SIZE=3 \
 *     npx vitest run src/server/ai/local-qwen-queue.live.test.ts
 *
 * Skipped otherwise, so it never runs in the normal suite or in CI.
 *
 * DATABASE_URL must arrive from the command line, not from a hook: Prisma reads
 * it when the client is constructed, which happens at import time.
 */

const LIVE = process.env.LOCAL_QUEUE_E2E === "true";

/**
 * GUARD — a non-local database would be production Supabase. Refuse before the
 * Prisma client below is even constructed.
 */
if (LIVE) {
  const url = process.env.DATABASE_URL ?? "";
  if (!/(127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(
      "GUARD VIOLATION: DATABASE_URL does not point at a local database. " +
        "This test must never touch production Supabase.",
    );
  }
}

import { prisma } from "@/lib/prisma";

import { processNextImport } from "@/services/import-queue.service";

const LOCAL_HOST = /127\.0\.0\.1|localhost/;

describe.skipIf(!LIVE)("LOCAL QUEUE E2E — Process Queue, end to end, on the local model", () => {
  it("analyzes the pending batch in ONE local request and marks it ready for review", async () => {
    // GUARD — anything leaving this machine is a hard failure. Gemini and Apify
    // must not be reached even if a stray key is present in the environment.
    const realFetch = globalThis.fetch;
    const requests: string[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (!LOCAL_HOST.test(url)) {
        throw new Error(`GUARD VIOLATION: outbound request to a non-local host: ${url}`);
      }
      return realFetch(input, init);
    }) as typeof fetch);

    const before = await prisma.importQueue.findMany({
      where: { status: "PENDING_ANALYSIS" },
      select: { id: true, instagramUrl: true, importJobId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(
      before.length,
      "seed the local queue first: npx tsx scripts/seed-local-queue.mts",
    ).toBeGreaterThan(0);

    const startedAt = Date.now();
    const result = await processNextImport();
    const durationMs = Date.now() - startedAt;

    // --- exactly ONE model request, and it went to the local server ---
    const modelCalls = requests.filter((u) => u.includes("/v1/chat/completions"));
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toContain("127.0.0.1:1234");
    expect(requests.filter((u) => u.includes("googleapis.com"))).toHaveLength(0);
    expect(requests.filter((u) => u.includes("apify.com"))).toHaveLength(0);

    // --- every seeded item is now reviewable, none failed ---
    const after = await prisma.importQueue.findMany({
      where: { id: { in: before.map((r) => r.id) } },
      select: { instagramUrl: true, status: true, error: true, importJobId: true },
      orderBy: { createdAt: "asc" },
    });

    for (const row of after) {
      expect(row.status, `${row.instagramUrl} did not reach review: ${row.error ?? ""}`).toBe(
        "READY_FOR_REVIEW",
      );
    }

    // The analysis itself lands on the job: the model's categories and summary
    // go into `preview`, and analyzedAt/analyzedBy record who produced them.
    const jobs = await prisma.importJob.findMany({
      where: { id: { in: after.map((r) => r.importJobId!).filter(Boolean) } },
      select: { handle: true, preview: true, analyzedAt: true, analyzedBy: true },
    });

    for (const job of jobs) {
      expect(job.analyzedAt, `${job.handle} was not stamped analyzed`).not.toBeNull();
      // Written by the LOCAL provider, never a Gemini project.
      expect(job.analyzedBy).toBe("local");
      expect(job.preview, `${job.handle} has no preview`).not.toBeNull();

      // The model's answer is nested under preview.aiResult; assert it is really
      // there, so a run that stamped the job but stored nothing cannot pass.
      const ai = (job.preview as { aiResult?: { categories?: unknown[]; hashtags?: unknown[] } })
        .aiResult;
      expect(ai, `${job.handle} has no aiResult`).toBeDefined();
      expect((ai!.categories ?? []).length, `${job.handle} got no categories`).toBeGreaterThan(0);
      expect((ai!.hashtags ?? []).length, `${job.handle} got no hashtags`).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log(
      "\n===== LOCAL QUEUE E2E =====\n" +
        `\nprocessNextImport(): ${JSON.stringify(result)}\n` +
        `duration           : ${(durationMs / 1000).toFixed(1)}s\n` +
        jobs
          .map((j) => {
            const preview = (j.preview ?? {}) as {
              aiResult?: {
                categories?: { id: string; confidence: number }[];
                hashtags?: string[];
                summary?: string | null;
                targetAudience?: string | null;
              };
            };
            const ai = preview.aiResult ?? {};
            return (
              `\n@${j.handle}\n` +
              `  analyzedBy: ${j.analyzedBy}\n` +
              `  categories: ${(ai.categories ?? []).map((c) => `${c.id}(${c.confidence})`).join(", ") || "(none)"}\n` +
              `  hashtags  : ${(ai.hashtags ?? []).join(" ") || "(none)"}\n` +
              `  audience  : ${ai.targetAudience ?? "null"}\n` +
              `  summary   : ${String(ai.summary ?? "null").slice(0, 120)}\n`
            );
          })
          .join("") +
        `\nHTTP: local model ${modelCalls.length} · Gemini 0 · Apify 0\n` +
        "\n===========================\n",
    );

    vi.unstubAllGlobals();
    await prisma.$disconnect();
  }, 600_000);
});
