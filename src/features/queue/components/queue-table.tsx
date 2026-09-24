"use client";

import { ListChecks } from "lucide-react";

import { InstagramLink } from "@/components/instagram-link";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DeleteQueueItemButton } from "@/features/queue/components/delete-queue-item-button";
import { RetryQueueItemButton } from "@/features/queue/components/retry-queue-item-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useQueue } from "@/hooks/use-queue";
import type { ImportQueueStatus } from "@/types";
import { formatDate } from "@/utils/format";

const STATUS_LABEL: Record<ImportQueueStatus, string> = {
  PENDING_PARSE: "Queued (parse)",
  PARSING: "Parsing",
  PENDING_ANALYSIS: "Queued (analysis)",
  ANALYZING: "Analyzing",
  READY_FOR_REVIEW: "Ready for review",
  PARSE_FAILED: "Parse failed",
  ANALYSIS_FAILED: "Analysis failed",
  SKIPPED_LOW_FOLLOWERS: "Skipped (low followers)",
  SKIPPED_DUPLICATE: "Skipped (already imported)",
  // Legacy (pre two-stage split).
  PENDING: "Pending",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

const STATUS_VARIANT: Record<
  ImportQueueStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  PENDING_PARSE: "outline",
  PARSING: "secondary",
  PENDING_ANALYSIS: "outline",
  ANALYZING: "secondary",
  READY_FOR_REVIEW: "default",
  PARSE_FAILED: "destructive",
  ANALYSIS_FAILED: "destructive",
  // A quality decision, not a failure — deliberately not destructive.
  SKIPPED_LOW_FOLLOWERS: "secondary",
  SKIPPED_DUPLICATE: "secondary",
  // Legacy (pre two-stage split).
  PENDING: "outline",
  PROCESSING: "secondary",
  COMPLETED: "default",
  FAILED: "destructive",
};

/** Failed statuses that can be retried from the row. */
const RETRYABLE: ReadonlySet<ImportQueueStatus> = new Set([
  "PARSE_FAILED",
  "ANALYSIS_FAILED",
  "FAILED",
]);

export function QueueTable() {
  const { data, isLoading, isError } = useQueue();

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
        icon={ListChecks}
        title="Could not load the queue"
        description="Check your database connection and try again."
      />
    );
  }

  const items = data ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="Queue is empty"
        description="Add Instagram URLs above, then run Process Queue."
      />
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instagram URL</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>Added</TableHead>
            <TableHead className="w-10 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <InstagramLink
                  url={item.instagramUrl}
                  className="inline-flex items-center gap-1 text-sm hover:underline"
                />
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
              </TableCell>
              <TableCell className="max-w-[280px] truncate text-xs text-destructive">
                {item.error ?? ""}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDate(item.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {RETRYABLE.has(item.status) && <RetryQueueItemButton id={item.id} />}
                  <DeleteQueueItemButton id={item.id} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
