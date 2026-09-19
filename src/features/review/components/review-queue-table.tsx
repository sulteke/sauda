"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, X } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/empty-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BOUTIQUE_STATUS_LABELS, BOUTIQUE_STATUS_VARIANTS } from "@/features/boutiques/schemas";
import type { BoutiqueDTO, BoutiqueStatus } from "@/types";
import { formatNumber } from "@/utils/format";

async function setStatus(id: string, status: BoutiqueStatus): Promise<void> {
  const res = await fetch(`/api/boutiques/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? "Update failed");
  }
}

const ALL_CITIES = "ALL";
const UNKNOWN_CITY = "UNKNOWN";

export function ReviewQueueTable({ items }: { items: BoutiqueDTO[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [cityFilter, setCityFilter] = useState<string>(ALL_CITIES);

  async function act(id: string, status: BoutiqueStatus, message: string) {
    setPendingId(id);
    try {
      await setStatus(id, status);
      toast.success(message);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setPendingId(null);
    }
  }

  // Whole queue empty — no filter to show.
  if (items.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing to review"
        description="Imported boutiques waiting for a decision will appear here."
      />
    );
  }

  // City options derived from the existing Boutique.city field in the current data.
  const cities = Array.from(
    new Set(items.map((b) => b.city).filter((c): c is string => Boolean(c && c.trim()))),
  ).sort((a, b) => a.localeCompare(b));
  const hasUnknown = items.some((b) => !b.city || !b.city.trim());

  const filtered = items.filter((b) => {
    if (cityFilter === ALL_CITIES) return true;
    if (cityFilter === UNKNOWN_CITY) return !b.city || !b.city.trim();
    return b.city === cityFilter;
  });

  const filterBar = (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">City</span>
      <Select value={cityFilter} onValueChange={setCityFilter}>
        <SelectTrigger className="w-52">
          <SelectValue placeholder="All Cities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CITIES}>All Cities</SelectItem>
          {cities.map((city) => (
            <SelectItem key={city} value={city}>
              {city}
            </SelectItem>
          ))}
          {hasUnknown ? <SelectItem value={UNKNOWN_CITY}>Unknown</SelectItem> : null}
        </SelectContent>
      </Select>
    </div>
  );

  if (filtered.length === 0) {
    return (
      <div className="space-y-4">
        {filterBar}
        <EmptyState
          icon={ClipboardCheck}
          title="No boutiques in this city"
          description="Choose “All Cities” to see the full review queue."
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
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((boutique) => (
            <TableRow key={boutique.id}>
              <TableCell>
                <Avatar className="h-9 w-9">
                  {boutique.avatarUrl ? (
                    <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
                  ) : null}
                  <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
              </TableCell>
              <TableCell className="font-medium">
                <Link href={`/boutiques/${boutique.id}`} className="hover:underline">
                  {boutique.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{boutique.category ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {boutique.followersCount != null ? formatNumber(boutique.followersCount) : "—"}
              </TableCell>
              <TableCell>
                <Badge variant={BOUTIQUE_STATUS_VARIANTS[boutique.status]}>
                  {BOUTIQUE_STATUS_LABELS[boutique.status]}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingId === boutique.id}
                    onClick={() => act(boutique.id, "APPROVED", "Approved")}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={pendingId === boutique.id}
                    onClick={() => act(boutique.id, "REJECTED", "Rejected")}
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
