"use client";

import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useRetryQueueItem } from "@/hooks/use-queue";

/** Retry control for a failed queue row. Re-queues the item for its own stage. */
export function RetryQueueItemButton({ id }: { id: string }) {
  const retry = useRetryQueueItem();

  async function handleRetry() {
    try {
      await retry.mutateAsync(id);
      toast.success("Queued for retry");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry queue item");
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Retry queue item"
      disabled={retry.isPending}
      onClick={handleRetry}
    >
      <RotateCcw className="h-4 w-4" />
    </Button>
  );
}
