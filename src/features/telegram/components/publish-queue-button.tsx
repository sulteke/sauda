"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

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
  const [done, setDone] = useState(0);

  async function publishAll() {
    setRunning(true);
    setDone(0);
    let count = 0;

    let limitReached = false;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await publishNext();
        if (result.processed) {
          count += 1;
          setDone(count);
        }
        // Allowance spent: the server left the boutique PENDING, so another call
        // would re-select it. Stop here; the rest publishes on the next day.
        if (result.dailyLimitReached) {
          limitReached = true;
          break;
        }
        keepGoing = result.processed && result.remaining > 0;
        // Only BETWEEN publications — never after the last one, where it would
        // just be dead time before the button re-enables.
        if (keepGoing) await sleep(PUBLISH_DELAY_MS);
      }
      if (limitReached) {
        toast.message("Daily publication limit reached", {
          description: `Processed ${count} this run. The remaining approved boutiques stay queued for tomorrow.`,
        });
      } else {
        toast.success(
          count > 0 ? `Published ${count} boutique${count === 1 ? "" : "s"}` : "Nothing to publish",
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Publishing failed");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <Button onClick={publishAll} disabled={running || pending === 0}>
      {running ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          Publishing{done > 0 ? ` (${done})` : ""}...
        </>
      ) : (
        <>
          <Send className="h-4 w-4" />
          Publish Queue
        </>
      )}
    </Button>
  );
}
