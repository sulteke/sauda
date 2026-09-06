"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAddToQueue } from "@/hooks/use-queue";

export function AddToQueueForm() {
  const [text, setText] = useState("");
  const addToQueue = useAddToQueue();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;

    try {
      const result = await addToQueue.mutateAsync(text);
      const parts = [`Added ${result.added} URL${result.added === 1 ? "" : "s"}`];
      if (result.skipped > 0) parts.push(`skipped ${result.skipped} invalid`);
      toast.success(parts.join(", "));
      setText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add to queue");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        placeholder={"https://instagram.com/boutique_one\nhttps://instagram.com/boutique_two"}
        className="font-mono text-xs"
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={addToQueue.isPending || !text.trim()}>
          {addToQueue.isPending ? "Adding..." : "Add to queue"}
        </Button>
      </div>
    </form>
  );
}
