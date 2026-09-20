"use client";

import { useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useDiscoveryCandidates, useQueueCandidates } from "@/hooks/use-discovery";
import { useProcessNext } from "@/hooks/use-queue";
import type { DiscoveryCandidateDTO, ImportQueueStatus } from "@/types";

/**
 * Apify safety cap: never activate more than this many Discovery candidates into
 * the import pipeline at once. We queue a batch, drain it fully, then queue the
 * next — so at most MAX_BATCH_SIZE parse jobs are ever pending.
 */
const MAX_BATCH_SIZE = 10;
/** Pause between process-next calls (matches Process Queue; avoids Gemini 429 bursts). */
const PROCESS_DELAY_MS = 4000;

// Terminal import-queue outcomes for one item (new + legacy statuses).
const SUCCESS_STATUSES: ImportQueueStatus[] = ["READY_FOR_REVIEW", "COMPLETED"];
const FAILED_STATUSES: ImportQueueStatus[] = ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"];
/** Below the follower quality gate — no AI was spent, so it is not a failure. */
const SKIPPED_STATUSES: ImportQueueStatus[] = ["SKIPPED_LOW_FOLLOWERS"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fresh read of the not-yet-imported (NEW) candidates, so each batch is current. */
async function fetchNewCandidates(): Promise<DiscoveryCandidateDTO[]> {
  const res = await fetch("/api/discovery");
  const json = (await res.json().catch(() => ({}))) as {
    data?: DiscoveryCandidateDTO[];
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? "Failed to load candidates");
  return json.data ?? [];
}

interface Progress {
  discovered: number;
  imported: number;
  batch: number;
  totalBatches: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Drives the whole Discovery → Import flow from ONE click: repeatedly takes up to
 * 10 NEW candidates, sends them to the existing import queue, and drains that
 * batch via the existing process-next loop before taking the next 10. Sequential
 * and browser-driven, so it never becomes a long-running Vercel request.
 */
export function AutoImportPanel() {
  const { data } = useDiscoveryCandidates();
  const queueCandidates = useQueueCandidates();
  const processNext = useProcessNext();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const stopRef = useRef(false);

  const newCount = data?.length ?? 0;

  async function start() {
    stopRef.current = false;
    setRunning(true);

    const discovered = newCount;
    const totalBatches = Math.max(1, Math.ceil(discovered / MAX_BATCH_SIZE));
    let imported = 0;
    let batch = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let limitReached = false;
    const render = () =>
      setProgress({ discovered, imported, batch, totalBatches, succeeded, failed, skipped });
    render();

    // Drain the import queue via the existing single-stage endpoint, counting the
    // terminal outcome of each item. Stops when the queue is empty, when the day's
    // analysis allowance runs out, or on Stop.
    async function drainQueue() {
      while (!stopRef.current) {
        const result = await processNext.mutateAsync();
        const status = result.item?.status;
        if (status && SUCCESS_STATUSES.includes(status)) succeeded += 1;
        else if (status && FAILED_STATUSES.includes(status)) failed += 1;
        else if (status && SKIPPED_STATUSES.includes(status)) skipped += 1;
        render();
        // Allowance spent: the server left the item untouched, so another call
        // would re-select it. Stop here; the rest waits for the next day.
        if (result.dailyLimitReached) {
          limitReached = true;
          break;
        }
        if (!result.processed || result.remaining === 0) break;
        await sleep(PROCESS_DELAY_MS);
      }
    }

    try {
      // Resume-safe: finish anything already in the queue before taking new batches.
      await drainQueue();

      while (!stopRef.current && !limitReached) {
        const candidates = await fetchNewCandidates();
        if (candidates.length === 0) break;

        batch += 1;
        const ids = candidates.slice(0, MAX_BATCH_SIZE).map((c) => c.id);
        const { queued } = await queueCandidates.mutateAsync(ids);
        if (queued === 0) break; // nothing eligible — avoid a spin loop
        imported += queued;
        if (batch > totalBatches) render(); // grew beyond the initial estimate
        render();

        await drainQueue();
      }

      const processed = succeeded + failed + skipped;
      const detail = `Succeeded ${succeeded} · Failed ${failed} · Skipped ${skipped}`;
      if (limitReached) {
        toast.message("Daily analysis limit reached", {
          description: `${processed} processed · ${detail}. Remaining candidates stay queued for tomorrow.`,
        });
      } else if (stopRef.current) {
        toast.message("Import paused", {
          description: `Processed ${processed} · ${detail}. Click Start Import to resume.`,
        });
      } else if (processed === 0 && imported === 0) {
        toast.success("Nothing to import");
      } else {
        toast.success("Import complete", {
          description: `${processed} processed · ${detail}`,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    stopRef.current = true;
  }

  const shown = progress ?? {
    discovered: newCount,
    imported: 0,
    batch: 0,
    totalBatches: Math.max(1, Math.ceil(newCount / MAX_BATCH_SIZE)),
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  const remaining = Math.max(0, shown.discovered - shown.imported);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing batch {shown.batch} / {shown.totalBatches} ({shown.imported} /{" "}
              {shown.discovered})...
            </Button>
            <Button variant="outline" onClick={stop}>
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </>
        ) : (
          <Button onClick={start} disabled={newCount === 0}>
            <Play className="h-4 w-4" />
            {progress ? "Resume import" : "Start Import (10 at a time)"}
          </Button>
        )}
      </div>

      {running || progress ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Discovered" value={shown.discovered} />
          <Stat label="Imported" value={shown.imported} />
          <Stat label="Remaining" value={remaining} />
          <Stat label="Batch" value={`${shown.batch} / ${shown.totalBatches}`} />
          <Stat label="Succeeded" value={shown.succeeded} />
          <Stat label="Skipped" value={shown.skipped} />
          <Stat label="Failed" value={shown.failed} />
        </div>
      ) : null}
    </div>
  );
}
