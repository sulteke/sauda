"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { type ClearQueueScope, useClearQueue, useQueue } from "@/hooks/use-queue";

export function QueueHeaderActions() {
  const { data } = useQueue();
  const clear = useClearQueue();
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  const items = data ?? [];
  const completedCount = items.filter((item) => item.status === "COMPLETED").length;
  const failedCount = items.filter((item) => item.status === "FAILED").length;
  const total = items.length;

  async function run(scope: ClearQueueScope) {
    try {
      const { deleted } = await clear.mutateAsync(scope);
      toast.success(`Deleted ${deleted} item${deleted === 1 ? "" : "s"}`);
      setConfirmAllOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear queue");
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={clear.isPending || completedCount === 0}
        onClick={() => run("COMPLETED")}
      >
        Clear Completed
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={clear.isPending || failedCount === 0}
        onClick={() => run("FAILED")}
      >
        Clear Failed
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={clear.isPending || total === 0}
        onClick={() => setConfirmAllOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
        Clear All
      </Button>

      <AlertDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the entire queue?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all {total} queue item{total === 1 ? "" : "s"} (including any
              that are processing). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clear.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run("ALL");
              }}
              disabled={clear.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clear.isPending ? "Clearing..." : "Clear All"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
