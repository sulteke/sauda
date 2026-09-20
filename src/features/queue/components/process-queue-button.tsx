"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useProcessNext, useQueue } from "@/hooks/use-queue";
import type { ImportQueueStatus } from "@/types";

/**
 * Pause between sequential process-next calls so the per-item Gemini analysis
 * calls don't hit the API in a tight burst and trip its rate limit (429). This
 * only paces the EXISTING sequential loop — it is not a long-running request.
 */
const PROCESS_DELAY_MS = 4000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Terminal outcomes of one queue item (new + legacy statuses).
const SUCCESS_STATUSES: ImportQueueStatus[] = ["READY_FOR_REVIEW", "COMPLETED"];
const FAILED_STATUSES: ImportQueueStatus[] = ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"];
/** Terminal quality outcome — neither a success nor a failure, so counted apart. */
const SKIPPED_STATUSES: ImportQueueStatus[] = ["SKIPPED_LOW_FOLLOWERS"];
// Items still needing work — used only for the initial progress denominator.
const ACTIONABLE_STATUSES: ImportQueueStatus[] = [
  "PENDING_PARSE",
  "PARSING",
  "PENDING_ANALYSIS",
  "ANALYZING",
];

/**
 * Processes the WHOLE import queue on a single click by repeatedly calling the
 * existing `/api/queue/process-next` endpoint — which advances exactly ONE stage
 * of ONE item per request (PENDING_PARSE→PARSING→PENDING_ANALYSIS→ANALYZING→
 * READY_FOR_REVIEW). Because each HTTP request does one short stage, this never
 * becomes a single long-running request and stays safe under Vercel's function
 * limit. Items run sequentially (one in flight at a time); a failed item is
 * recorded server-side and the loop continues with the rest.
 */
export function ProcessQueueButton() {
  const processNext = useProcessNext();
  const { data: queueItems } = useQueue();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  async function processAll() {
    // Best-effort initial denominator (self-corrects from each response below).
    let total = (queueItems ?? []).filter((i) => ACTIONABLE_STATUSES.includes(i.status)).length;
    setProgress({ done: 0, total });
    setRunning(true);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let remaining = 0;
    let limitReached = false;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await processNext.mutateAsync();
        remaining = result.remaining;

        // Count only ITEM-terminal outcomes (parse→PENDING_ANALYSIS is a mid step).
        const status = result.item?.status;
        if (status && SUCCESS_STATUSES.includes(status)) succeeded += 1;
        else if (status && FAILED_STATUSES.includes(status)) failed += 1;
        else if (status && SKIPPED_STATUSES.includes(status)) skipped += 1;

        const done = succeeded + failed + skipped;
        total = Math.max(total, done + remaining);
        setProgress({ done, total });

        // The daily AI allowance is spent: the server left the item untouched,
        // so looping would just re-select it. Stop and resume tomorrow.
        if (result.dailyLimitReached) {
          limitReached = true;
          break;
        }

        keepGoing = result.processed && result.remaining > 0;
        // Space out calls so Gemini analyses don't burst into a 429.
        if (keepGoing) await sleep(PROCESS_DELAY_MS);
      }

      const processed = succeeded + failed + skipped;
      const detail = `Succeeded: ${succeeded} · Failed: ${failed} · Skipped: ${skipped} · Remaining: ${remaining}`;
      if (limitReached) {
        toast.message("Daily analysis limit reached", {
          description: `${detail}. The rest resumes tomorrow.`,
        });
      } else if (processed === 0) {
        toast.success("Queue is empty");
      } else {
        toast.success(`Processed ${processed} item${processed === 1 ? "" : "s"}`, {
          description: detail,
        });
      }
    } catch (error) {
      // A thrown error is an infra/network issue (per-item failures don't throw).
      toast.error(error instanceof Error ? error.message : "Processing failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Button onClick={processAll} disabled={running}>
      {running ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          Processing {progress.done} / {progress.total}...
        </>
      ) : (
        <>
          <Play className="h-4 w-4" />
          Process Queue
        </>
      )}
    </Button>
  );
}
