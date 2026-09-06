"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Store } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { BoutiqueRowActions } from "@/features/boutiques/components/boutique-row-actions";
import { BOUTIQUE_STATUS_LABELS, BOUTIQUE_STATUS_VARIANTS } from "@/features/boutiques/schemas";
import { useBoutiques } from "@/hooks/use-boutiques";
import { useUIStore } from "@/hooks/use-ui-store";
import { formatNumber } from "@/utils/format";

export function BoutiquesTable() {
  const router = useRouter();
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
      (boutique.city ?? "").toLowerCase().includes(query) ||
      (boutique.category ?? "").toLowerCase().includes(query)
    );
  });

  if (boutiques.length === 0) {
    return (
      <EmptyState
        icon={Store}
        title="No boutiques yet"
        description={
          query ? "No boutiques match your search." : "Imported boutiques will appear here."
        }
      />
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <span className="sr-only">Avatar</span>
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Followers</TableHead>
            <TableHead>City</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {boutiques.map((boutique) => (
            <TableRow
              key={boutique.id}
              className="cursor-pointer"
              onClick={() => router.push(`/boutiques/${boutique.id}`)}
            >
              <TableCell>
                <Avatar className="h-9 w-9">
                  {boutique.avatarUrl ? (
                    <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
                  ) : null}
                  <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
              </TableCell>
              <TableCell className="font-medium">
                <Link
                  href={`/boutiques/${boutique.id}`}
                  className="hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {boutique.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{boutique.category ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {boutique.followersCount != null ? formatNumber(boutique.followersCount) : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">{boutique.city ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={BOUTIQUE_STATUS_VARIANTS[boutique.status]}>
                  {BOUTIQUE_STATUS_LABELS[boutique.status]}
                </Badge>
              </TableCell>
              <TableCell onClick={(event) => event.stopPropagation()}>
                <BoutiqueRowActions boutique={boutique} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
