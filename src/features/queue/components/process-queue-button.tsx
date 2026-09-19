"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useProcessNext, useQueue } from "@/hooks/use-queue";
import type { ImportQueueStatus } from "@/types";

// Terminal outcomes of one queue item (new + legacy statuses).
const SUCCESS_STATUSES: ImportQueueStatus[] = ["READY_FOR_REVIEW", "COMPLETED"];
const FAILED_STATUSES: ImportQueueStatus[] = ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"];
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
    let remaining = 0;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await processNext.mutateAsync();
        remaining = result.remaining;

        // Count only ITEM-terminal outcomes (parse→PENDING_ANALYSIS is a mid step).
        const status = result.item?.status;
        if (status && SUCCESS_STATUSES.includes(status)) succeeded += 1;
        else if (status && FAILED_STATUSES.includes(status)) failed += 1;

        const done = succeeded + failed;
        total = Math.max(total, done + remaining);
        setProgress({ done, total });

        keepGoing = result.processed && result.remaining > 0;
      }

      const processed = succeeded + failed;
      if (processed === 0) {
        toast.success("Queue is empty");
      } else {
        toast.success(`Processed ${processed} item${processed === 1 ? "" : "s"}`, {
          description: `Succeeded: ${succeeded} · Failed: ${failed} · Remaining: ${remaining}`,
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
