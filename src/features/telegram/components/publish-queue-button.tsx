"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface ProcessResult {
  processed: boolean;
  remaining: number;
  status: string | null;
  error: string | null;
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

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await publishNext();
        if (result.processed) {
          count += 1;
          setDone(count);
        }
        keepGoing = result.processed && result.remaining > 0;
      }
      toast.success(
        count > 0 ? `Published ${count} boutique${count === 1 ? "" : "s"}` : "Nothing to publish",
      );
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
