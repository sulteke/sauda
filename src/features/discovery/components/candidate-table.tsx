"use client";

import { useState } from "react";
import { Compass } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useDiscoveryCandidates,
  useDismissCandidates,
  useQueueCandidates,
} from "@/hooks/use-discovery";

export function CandidateTable() {
  const { data, isLoading, isError } = useDiscoveryCandidates();
  const queueMutation = useQueueCandidates();
  const dismissMutation = useDismissCandidates();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const items = data ?? [];
  const busy = queueMutation.isPending || dismissMutation.isPending;
  const selectedIds = items.map((item) => item.id).filter((id) => selected.has(id));
  const allSelected = items.length > 0 && selectedIds.length === items.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  }

  async function queueSelected() {
    try {
      const result = await queueMutation.mutateAsync(selectedIds);
      toast.success(`Queued ${result.queued} for import`);
      setSelected(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue");
    }
  }

  async function dismissSelected() {
    try {
      const result = await dismissMutation.mutateAsync(selectedIds);
      toast.success(`Dismissed ${result.dismissed}`);
      setSelected(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dismiss");
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={Compass}
        title="Could not load candidates"
        description="Check your database connection and try again."
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Compass}
        title="No candidates yet"
        description="Run discovery above to find candidate boutique accounts."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={queueSelected} disabled={busy || selectedIds.length === 0}>
          Send to import queue{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={dismissSelected}
          disabled={busy || selectedIds.length === 0}
        >
          Dismiss
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Seed</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((candidate) => (
              <TableRow
                key={candidate.id}
                data-state={selected.has(candidate.id) ? "selected" : undefined}
              >
                <TableCell>
                  <Checkbox
                    checked={selected.has(candidate.id)}
                    onCheckedChange={() => toggle(candidate.id)}
                    aria-label={`Select ${candidate.handle}`}
                  />
                </TableCell>
                <TableCell className="font-medium">
                  <a
                    href={candidate.instagramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    @{candidate.handle}
                  </a>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {candidate.seedType === "HASHTAG"
                      ? `#${candidate.seedValue}`
                      : `@${candidate.seedValue}`}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{candidate.source ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
