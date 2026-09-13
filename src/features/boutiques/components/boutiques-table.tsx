"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Store } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ASTANA, canonicalKzCity, isAlmaty, SHYMKENT } from "@/lib/location";
import type { BoutiqueDTO } from "@/types";
import { formatNumber } from "@/utils/format";

type CityFilter = "ALL" | "ALMATY" | "ASTANA" | "SHYMKENT" | "OTHER" | "UNKNOWN";

const CITY_FILTERS: { value: CityFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "ALMATY", label: "Алматы" },
  { value: "ASTANA", label: "Астана" },
  { value: "SHYMKENT", label: "Шымкент" },
  { value: "OTHER", label: "Other" },
  { value: "UNKNOWN", label: "Unknown" },
];

/** Matches a boutique against the selected city filter. */
function matchesCityFilter(boutique: BoutiqueDTO, filter: CityFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "UNKNOWN") return !boutique.city;
  if (filter === "ALMATY") return isAlmaty(boutique.city);
  const canonical = canonicalKzCity(boutique.city);
  if (filter === "ASTANA") return canonical === ASTANA;
  if (filter === "SHYMKENT") return canonical === SHYMKENT;
  // OTHER: a named city that is not Almaty / Astana / Shymkent.
  return Boolean(boutique.city) && !isAlmaty(boutique.city) && canonical !== ASTANA && canonical !== SHYMKENT;
}

export function BoutiquesTable() {
  const router = useRouter();
  const { data, isLoading, isError } = useBoutiques();
  const searchQuery = useUIStore((state) => state.searchQuery);
  const [cityFilter, setCityFilter] = useState<CityFilter>("ALL");

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
    if (!matchesCityFilter(boutique, cityFilter)) return false;
    if (!query) return true;
    return (
      boutique.name.toLowerCase().includes(query) ||
      (boutique.city ?? "").toLowerCase().includes(query) ||
      (boutique.category ?? "").toLowerCase().includes(query)
    );
  });

  const filterBar = (
    <div className="flex flex-wrap gap-2">
      {CITY_FILTERS.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={cityFilter === option.value ? "default" : "outline"}
          onClick={() => setCityFilter(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );

  if (boutiques.length === 0) {
    return (
      <div className="space-y-4">
        {filterBar}
        <EmptyState
          icon={Store}
          title="No boutiques yet"
          description={
            query || cityFilter !== "ALL"
              ? "No boutiques match the current filters."
              : "Imported boutiques will appear here."
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filterBar}
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
    </div>
  );
}
