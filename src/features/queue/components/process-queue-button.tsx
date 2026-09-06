"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useProcessNext } from "@/hooks/use-queue";

export function ProcessQueueButton() {
  const processNext = useProcessNext();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);

  async function processAll() {
    setRunning(true);
    setDone(0);
    let processedCount = 0;

    try {
      let keepGoing = true;
      while (keepGoing) {
        const result = await processNext.mutateAsync();
        if (result.processed) {
          processedCount += 1;
          setDone(processedCount);
        }
        keepGoing = result.processed && result.remaining > 0;
      }
      toast.success(
        processedCount > 0
          ? `Processed ${processedCount} item${processedCount === 1 ? "" : "s"}`
          : "Queue is empty",
      );
    } catch (error) {
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
          Processing{done > 0 ? ` (${done})` : ""}...
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
