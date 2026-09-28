"use client";

import { useRef, useState } from "react";
import { Loader2, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useProcessNext, useQueue } from "@/hooks/use-queue";
import type { ImportQueueStatus, QueueStage } from "@/types";

/**
 * Pause between sequential process-next calls so the per-item Gemini analysis
 * calls don't hit the API in a tight burst and trip its rate limit (429). This
 * only paces the EXISTING sequential loop — it is not a long-running request.
 */
const PROCESS_DELAY_MS = 4000;
/**
 * Ceiling on a single cooldown wait. The server's cooldown is minutes long, so
 * this only guards against a stale row or a skewed clock parking the run for
 * ever; on reaching it the loop simply tries again rather than giving up.
 */
const MAX_PAUSE_MS = 15 * 60 * 1000;
/**
 * How many cooldowns in a row may pass without a single item advancing before
 * the run gives up. A passing blip clears in one wait; this many failures in a
 * row means the outage is sustained, and a browser tab should not sit there
 * retrying all night. Any successful item resets the count.
 */
const MAX_CONSECUTIVE_PAUSES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Terminal outcomes of one queue item (new + legacy statuses).
const SUCCESS_STATUSES: ImportQueueStatus[] = ["READY_FOR_REVIEW", "COMPLETED"];
const FAILED_STATUSES: ImportQueueStatus[] = ["PARSE_FAILED", "ANALYSIS_FAILED", "FAILED"];
/** Terminal quality outcome — neither a success nor a failure, so counted apart. */
const SKIPPED_STATUSES: ImportQueueStatus[] = ["SKIPPED_LOW_FOLLOWERS", "SKIPPED_DUPLICATE"];
// Items still needing work — used only for the initial progress denominator.
const ACTIONABLE_STATUSES: ImportQueueStatus[] = [
  "PENDING_PARSE",
  "PARSING",
  "PENDING_ANALYSIS",
  "ANALYZING",
];

/** What a run of each kind can actually pick up, for the progress denominator. */
const STAGE_STATUSES: Record<QueueStage, ImportQueueStatus[]> = {
  parse: ["PENDING_PARSE", "PARSING"],
  analyze: ["PENDING_ANALYSIS", "ANALYZING"],
};

const STAGE_LABEL: Record<QueueStage, string> = {
  parse: "Parse only",
  analyze: "Analyze only",
};

/** m:ss for the countdown shown while the run is parked on a cooldown. */
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Processes the WHOLE import queue on a single click by repeatedly calling the
 * existing `/api/queue/process-next` endpoint — which advances exactly ONE stage
 * of ONE item per request (PENDING_PARSE→PARSING→PENDING_ANALYSIS→ANALYZING→
 * READY_FOR_REVIEW). Because each HTTP request does one short stage, this never
 * becomes a single long-running request and stays safe under Vercel's function
 * limit. Items run sequentially (one in flight at a time); a failed item is
 * recorded server-side and the loop continues with the rest.
 *
 * When every AI project is briefly unwell (a 503/504 blip or a rate-limit
 * bounce) the server reports WHEN one becomes usable again. The run then parks
 * with a visible countdown and carries on by itself — only a genuinely spent
 * daily allowance ends the run, because that one cannot clear before tomorrow.
 */
export function ProcessQueueButton() {
  const processNext = useProcessNext();
  const { data: queueItems } = useQueue();
  const [running, setRunning] = useState(false);
  /** Which kind of run is in flight, so only one can start and the label says which. */
  const [runningStage, setRunningStage] = useState<QueueStage | "all" | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** Seconds left on the current cooldown wait; 0 when not parked. */
  const [pausedFor, setPausedFor] = useState(0);
  const stopRef = useRef(false);

  /**
   * Sits out a provider cooldown, ticking the countdown every second so the wait
   * is visible and Stop stays responsive. Returns false if the user stopped.
   */
  async function waitForRetry(until: string): Promise<boolean> {
    const target = new Date(until).getTime();
    const deadline = Number.isFinite(target)
      ? Math.min(target, Date.now() + MAX_PAUSE_MS)
      : Date.now() + PROCESS_DELAY_MS;

    while (Date.now() < deadline) {
      if (stopRef.current) break;
      setPausedFor(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      await sleep(1000);
    }

    setPausedFor(0);
    return !stopRef.current;
  }

  /**
   * Runs the queue to completion, optionally restricted to ONE stage.
   *
   * Without a stage the queue chooses for itself, as it always has. With one,
   * only that stage runs — scraping spends Apify credit and analysis spends
   * time on whichever model a shop is routed to, so they are worth doing at
   * different moments, and separately.
   */
  async function processAll(stage?: QueueStage) {
    // Best-effort initial denominator (self-corrects from each response below).
    const counted = stage ? STAGE_STATUSES[stage] : ACTIONABLE_STATUSES;
    let total = (queueItems ?? []).filter((i) => counted.includes(i.status)).length;
    setProgress({ done: 0, total });
    setPausedFor(0);
    stopRef.current = false;
    setRunning(true);
    setRunningStage(stage ?? "all");

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let remaining = 0;
    let pauses = 0;
    let consecutivePauses = 0;
    let limitReached = false;
    let stopped = false;
    let providersDown = false;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await processNext.mutateAsync(stage);
        remaining = result.remaining;

        // One call can settle a whole batch, so count every item it returned —
        // reading only `item` would under-report a batched analyze run.
        const settled = result.items ?? (result.item ? [result.item] : []);
        for (const entry of settled) {
          if (SUCCESS_STATUSES.includes(entry.status)) succeeded += 1;
          else if (FAILED_STATUSES.includes(entry.status)) failed += 1;
          else if (SKIPPED_STATUSES.includes(entry.status)) skipped += 1;
        }

        const done = succeeded + failed + skipped;
        total = Math.max(total, done + remaining);
        setProgress({ done, total });

        // Real progress means the outage passed — start counting again.
        if (result.processed) consecutivePauses = 0;

        if (stopRef.current) {
          stopped = true;
          break;
        }

        // Every project is cooling down but still has allowance left. The item
        // was left untouched, so wait for the soonest one and pick it up again.
        if (result.retryAfter && remaining > 0) {
          consecutivePauses += 1;
          if (consecutivePauses > MAX_CONSECUTIVE_PAUSES) {
            providersDown = true;
            break;
          }
          pauses += 1;
          if (!(await waitForRetry(result.retryAfter))) {
            stopped = true;
            break;
          }
          continue;
        }

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
      const waited = pauses > 0 ? ` Waited out ${pauses} cooldown${pauses === 1 ? "" : "s"}.` : "";
      if (limitReached) {
        toast.message("Daily analysis limit reached", {
          description: `${detail}. The rest resumes tomorrow.${waited}`,
        });
      } else if (providersDown) {
        toast.error("AI providers still unavailable", {
          description: `Every project stayed down across ${MAX_CONSECUTIVE_PAUSES} retries. ${detail}. Nothing was lost — try again later.`,
        });
      } else if (stopped) {
        toast.message("Stopped", { description: detail });
      } else if (processed === 0) {
        toast.success("Queue is empty");
      } else {
        toast.success(`Processed ${processed} item${processed === 1 ? "" : "s"}`, {
          description: `${detail}.${waited}`,
        });
      }
    } catch (error) {
      // A thrown error is an infra/network issue (per-item failures don't throw).
      toast.error(error instanceof Error ? error.message : "Processing failed");
    } finally {
      setRunning(false);
      setRunningStage(null);
      setPausedFor(0);
    }
  }

  /** The running label, which names the stage so two runs cannot be confused. */
  function runningLabel() {
    if (pausedFor > 0) {
      return (
        <>
          <Pause className="h-4 w-4" />
          Paused — resuming in {formatCountdown(pausedFor)}
        </>
      );
    }
    const what = runningStage && runningStage !== "all" ? `${STAGE_LABEL[runningStage]} — ` : "";
    return (
      <>
        <Loader2 className="h-4 w-4 animate-spin" />
        {what}
        {progress.done} / {progress.total}...
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => processAll()} disabled={running}>
        {running && runningStage === "all" ? (
          runningLabel()
        ) : (
          <>
            <Play className="h-4 w-4" />
            Process Queue
          </>
        )}
      </Button>

      {/* The same loop, restricted to one stage. Only one run at a time: every
          trigger is disabled while any of them is going. */}
      {(["parse", "analyze"] as const).map((stage) => (
        <Button key={stage} variant="outline" onClick={() => processAll(stage)} disabled={running}>
          {running && runningStage === stage ? (
            runningLabel()
          ) : (
            <>
              <Play className="h-4 w-4" />
              {STAGE_LABEL[stage]}
            </>
          )}
        </Button>
      ))}

      {running && (
        <Button variant="outline" onClick={() => (stopRef.current = true)}>
          <Square className="h-4 w-4" />
          Stop
        </Button>
      )}
    </div>
  );
}
