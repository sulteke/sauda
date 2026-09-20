"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { BoutiqueDTO } from "@/types";

/**
 * A boutique the publisher skipped, with a manual override for the one case a
 * human can genuinely resolve: an UNDETECTED location.
 *
 * The override is deliberately narrow. It appears only when no city was
 * detected — a boutique confidently detected in another city is a publishing
 * decision the admin should not be nudged to reverse from here. Confirming
 * publishes immediately; it does NOT rewrite the detected city (the record
 * stays Unknown, so detection quality remains measurable) and it does NOT
 * bypass the daily publication limit, which the server enforces either way.
 */
export function SkippedBoutiqueCard({ boutique }: { boutique: BoutiqueDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const cityUnknown = !boutique.city;
  const alreadyOverridden = Boolean(boutique.telegramOverrideCity);

  async function publishAnyway() {
    setPublishing(true);
    try {
      const res = await fetch(`/api/telegram/${boutique.id}/publish-override`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Publish failed");
      toast.success(`Published ${boutique.name} to Telegram`);
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="rounded-md border p-2">
      <div className="flex items-start gap-2">
        <Avatar className="h-8 w-8">
          {boutique.avatarUrl ? <AvatarImage src={boutique.avatarUrl} alt={boutique.name} /> : null}
          <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{boutique.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            📍 {boutique.city ?? "Unknown"}
          </div>
        </div>
      </div>

      {cityUnknown && !alreadyOverridden ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-2 text-xs"
          onClick={() => setOpen(true)}
        >
          Publish anyway
        </Button>
      ) : null}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to Telegram anyway?</AlertDialogTitle>
            <AlertDialogDescription>
              Detected location: Unknown. By continuing you confirm that this boutique is relevant
              to Almaty.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void publishAnyway();
              }}
              disabled={publishing}
            >
              {publishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Publishing...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Publish
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
