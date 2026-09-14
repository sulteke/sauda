"use client";

import { type ReactNode, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";

import { InstagramLink } from "@/components/instagram-link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { BoutiqueDTO } from "@/types";
import { formatDate } from "@/utils/format";

/** One row in the detail modal. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * A compact failed-publication card. Shows the name and a short (2-line) error;
 * "View details" opens a modal with the full Telegram API error, HTTP status,
 * target, time, boutique id, Instagram link, and a copy button.
 */
export function FailedBoutiqueCard({ boutique }: { boutique: BoutiqueDTO }) {
  const failure = boutique.telegramFailure;
  // Full message prefers the structured detail; falls back to the raw column.
  const fullMessage = failure?.message ?? boutique.telegramError ?? "Unknown error";
  const failedAt = failure?.failedAt ?? boutique.updatedAt;
  const [copied, setCopied] = useState(false);

  async function copyError() {
    // Copy the richest thing available — the full response, else the message.
    const text = failure?.response?.trim() ? failure.response : fullMessage;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (permissions); silently ignore.
    }
  }

  return (
    <div className="rounded-md border p-2">
      <div className="flex items-start gap-2">
        <Avatar className="h-8 w-8">
          {boutique.avatarUrl ? (
            <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
          ) : null}
          <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{boutique.name}</div>
          {/* Short error — kept to 2 lines to keep the card compact. */}
          <p className="line-clamp-2 text-xs text-destructive">{fullMessage}</p>
        </div>
      </div>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs">
            View details
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate">{boutique.name}</DialogTitle>
            <DialogDescription>Telegram publication failure details.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <DetailRow label="Target">{failure?.targetLabel || failure?.targetId || "—"}</DetailRow>
            <DetailRow label="HTTP status">{failure?.httpStatus ?? "—"}</DetailRow>
            <DetailRow label="Time">{failedAt ? formatDate(failedAt) : "—"}</DetailRow>
            <DetailRow label="Boutique ID">
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{boutique.id}</code>
            </DetailRow>
            <DetailRow label="Instagram">
              <InstagramLink
                url={boutique.instagramUrl}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              />
            </DetailRow>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Full error
                </span>
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={copyError}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">
                {fullMessage}
                {failure?.response && failure.response.trim() !== fullMessage.trim()
                  ? `\n\n--- Raw API response ---\n${failure.response}`
                  : ""}
              </pre>
            </div>

            {boutique.instagramUrl ? (
              <a
                href={boutique.instagramUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Open Instagram profile
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
