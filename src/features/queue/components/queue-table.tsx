"use client";

import { ListChecks } from "lucide-react";

import { InstagramLink } from "@/components/instagram-link";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  PENDING: "Pending",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

const STATUS_VARIANT: Record<
  ImportQueueStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  PENDING: "outline",
  PROCESSING: "secondary",
  COMPLETED: "default",
  FAILED: "destructive",
};

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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
