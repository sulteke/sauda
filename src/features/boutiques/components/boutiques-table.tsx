"use client";

import { Store } from "lucide-react";

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
import { useBoutiques } from "@/hooks/use-boutiques";
import { useUIStore } from "@/hooks/use-ui-store";
import type { BoutiqueStatus } from "@/types";
import { formatDate } from "@/utils/format";

const STATUS_LABEL: Record<BoutiqueStatus, string> = {
  DRAFT: "Draft",
  NEEDS_REVIEW: "Needs review",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

const STATUS_VARIANT: Record<BoutiqueStatus, "default" | "secondary" | "outline" | "destructive"> =
  {
    DRAFT: "outline",
    NEEDS_REVIEW: "secondary",
    PUBLISHED: "default",
    ARCHIVED: "destructive",
  };

export function BoutiquesTable() {
  const { data, isLoading, isError } = useBoutiques();
  const searchQuery = useUIStore((state) => state.searchQuery);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={Store}
        title="Could not load boutiques"
        description="Check your database connection and try again."
      />
    );
  }

  const query = searchQuery.trim().toLowerCase();
  const boutiques = (data ?? []).filter((boutique) => {
    if (!query) return true;
    return (
      boutique.name.toLowerCase().includes(query) ||
      (boutique.city ?? "").toLowerCase().includes(query)
    );
  });

  if (boutiques.length === 0) {
    return (
      <EmptyState
        icon={Store}
        title="No boutiques yet"
        description={
          query ? "No boutiques match your search." : "Boutiques you add will appear here."
        }
      />
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>City</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {boutiques.map((boutique) => (
            <TableRow key={boutique.id}>
              <TableCell className="font-medium">{boutique.name}</TableCell>
              <TableCell className="text-muted-foreground">{boutique.city ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[boutique.status]}>
                  {STATUS_LABEL[boutique.status]}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(boutique.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
