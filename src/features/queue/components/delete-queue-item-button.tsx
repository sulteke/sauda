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
import { useDeleteQueueItem } from "@/hooks/use-queue";

export function DeleteQueueItemButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const deleteItem = useDeleteQueueItem();

  async function handleDelete() {
    try {
      await deleteItem.mutateAsync(id);
      toast.success("Queue item deleted");
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete queue item");
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete queue item"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete queue item?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this queue item?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteItem.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              disabled={deleteItem.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteItem.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
