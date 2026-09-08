"use client";

import { BadgeCheck, CheckCircle2, ExternalLink, Loader2, Sparkles, Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ImportJobDTO } from "@/types";
import { formatNumber } from "@/utils/format";

interface ImportPreviewProps {
  job: ImportJobDTO;
  onSave: () => void;
  onReset: () => void;
  isSaving?: boolean;
}

export function ImportPreview({ job, onSave, onReset, isSaving = false }: ImportPreviewProps) {
  const preview = job.preview;
  if (!preview) return null;

  const isCompleted = job.status === "COMPLETED";
  const initial = preview.name.charAt(0).toUpperCase() || "B";
  const isMock = process.env.NEXT_PUBLIC_USE_MOCK_PROVIDER !== "false";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {isCompleted ? "Boutique saved" : "Discovered profile"}
        </CardTitle>
        {isMock ? (
          <Badge variant="secondary">Mock data</Badge>
        ) : (
          <Badge variant="outline">Instagram</Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex items-start gap-4">
          <Avatar className="h-14 w-14">
            {preview.avatarUrl ? <AvatarImage src={preview.avatarUrl} alt={preview.name} /> : null}
            <AvatarFallback className="text-lg">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold">{preview.name}</span>
              {preview.isVerified ? (
                <BadgeCheck className="h-4 w-4 shrink-0 text-sky-500" aria-label="Verified" />
              ) : null}
            </div>
            <a
              href={preview.instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              @{preview.instagramHandle}
              <ExternalLink className="h-3 w-3" />
            </a>
            <div className="flex flex-wrap items-center gap-3 pt-1 text-sm text-muted-foreground">
              {preview.followersCount !== null ? (
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {formatNumber(preview.followersCount)} followers
                </span>
              ) : null}
              {preview.productCategories && preview.productCategories.length > 0
                ? preview.productCategories.map((cat) => (
                    <Badge key={cat.id} variant="outline">
                      {cat.label}
                    </Badge>
                  ))
                : preview.category
                  ? <Badge variant="outline">{preview.category}</Badge>
                  : null}
            </div>
          </div>
        </div>

        {preview.description ? (
          <p className="text-sm text-muted-foreground">{preview.description}</p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border p-4 text-sm">
          <Field label="Boutique name" value={preview.name} />
          <Field label="Slug" value={preview.slug} mono />
          <Field label="City" value={preview.city ?? "—"} />
          <Field label="Status on save" value="Draft" />
        </dl>

        {isCompleted ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Saved as a boutique.
            </p>
            <Button variant="outline" onClick={onReset}>
              Import another
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onReset} disabled={isSaving}>
              Start over
            </Button>
            <Button onClick={onSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save boutique"
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-sm" : "text-sm font-medium"}>{value}</dd>
    </div>
  );
}
