"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  describeTally,
  EMPTY_TALLY,
  MAX_CONSECUTIVE_FAILURES,
  type PublishRunTally,
  shouldStopForFailures,
  tallyResult,
} from "@/features/telegram/publish-run";

/**
 * Pause between publications.
 *
 * Telegram limits a chat by the MINUTE, so the daily ceiling protects nothing
 * here — the shape that trips a 429 is a run that posts as fast as the server
 * answers. Most posts are photo albums that take tens of seconds to upload and
 * pace themselves, but a short one returns immediately, and a run of those is
 * exactly what an unpaced loop would send. Three seconds is the floor that
 * keeps even instant replies under twenty a minute; four leaves margin, and is
 * the pause the import queue already uses for the same reason.
 */
const PUBLISH_DELAY_MS = 4000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ProcessResult {
  processed: boolean;
  remaining: number;
  status: string | null;
  error: string | null;
  /** The failure's known cause, e.g. IMAGES_EXPIRED. */
  errorCode?: string | null;
  /** Today's publication allowance is spent — stop and resume tomorrow. */
  dailyLimitReached?: boolean;
  publishedToday?: number;
}

async function publishNext(): Promise<ProcessResult> {
  const res = await fetch("/api/telegram/publish-next", { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as { data?: ProcessResult; error?: string };
  if (!res.ok || !json.data) {
    throw new Error(json.error ?? "Publish failed");
  }
  return json.data;
}

export function PublishQueueButton({ pending }: { pending: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [tally, setTally] = useState<PublishRunTally>(EMPTY_TALLY);
  /**
   * Set by the Stop button and read between posts. A run used to have no way
   * to be stopped short of leaving the page.
   */
  const stopRef = useRef(false);

  async function publishAll() {
    setRunning(true);
    setTally(EMPTY_TALLY);
    stopRef.current = false;

    let current = EMPTY_TALLY;
    let limitReached = false;
    let stoppedForFailures = false;
    let stoppedByUser = false;
    let lastError: string | null = null;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await publishNext();
        if (result.processed) {
          current = tallyResult(current, result.status, result.errorCode ?? null);
          setTally(current);
          if (result.status === "FAILED") lastError = result.error;
        }
        // Allowance spent: the server left the boutique PENDING, so another call
        // would re-select it. Stop here; the rest publishes on the next day.
        if (result.dailyLimitReached) {
          limitReached = true;
          break;
        }
        // Failures do not count toward the daily limit, so nothing else stops a
        // run in which every post fails. Give up before it walks the queue.
        if (shouldStopForFailures(current)) {
          stoppedForFailures = true;
          break;
        }
        if (stopRef.current) {
          stoppedByUser = true;
          break;
        }
        keepGoing = result.processed && result.remaining > 0;
        // Only BETWEEN publications — never after the last one, where it would
        // just be dead time before the button re-enables.
        if (keepGoing) await sleep(PUBLISH_DELAY_MS);
      }

      const detail = describeTally(current);
      if (stoppedForFailures) {
        toast.error(`Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row`, {
          description: `${detail}. The rest are still queued. Last error: ${lastError ?? "unknown"}`,
        });
      } else if (limitReached) {
        toast.message("Daily publication limit reached", {
          description: `${detail}. The remaining approved boutiques stay queued for tomorrow.`,
        });
      } else if (stoppedByUser) {
        toast.message("Stopped", { description: `${detail}. The rest are still queued.` });
      } else if (current.published + current.failed + current.skipped === 0) {
        toast.success("Nothing to publish");
      } else if (current.failed > 0) {
        toast.error("Finished with failures", { description: detail });
      } else {
        toast.success(`Published ${current.published}`, { description: detail });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Publishing failed");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  const settled = tally.published + tally.failed + tally.skipped;

  return (
    <div className="flex items-center gap-2">
      <Button onClick={publishAll} disabled={running || pending === 0}>
        {running ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Publishing{settled > 0 ? ` (${tally.published} sent` : ""}
            {settled > 0 && tally.failed > 0 ? `, ${tally.failed} failed` : ""}
            {settled > 0 ? ")" : ""}...
          </>
        ) : (
          <>
            <Send className="h-4 w-4" />
            Publish Queue
          </>
        )}
      </Button>
      {running && (
        <Button variant="outline" onClick={() => (stopRef.current = true)}>
          <Square className="h-4 w-4" />
          Stop
        </Button>
      )}
    </div>
  );
}
