"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BoutiqueDTO, CategoryMatch, ProductCategory } from "@/types";

const MATCH_SOURCE_LABELS: Record<CategoryMatch["source"], string> = {
  biography: "bio",
  hashtag: "hashtag",
  caption: "caption",
  mention: "mention",
};

/** Renders one piece of match evidence, e.g. "#hoodie (hashtag)" or "худи (bio ×2)". */
function formatMatch(match: CategoryMatch): string {
  const term = match.source === "hashtag" ? `#${match.keyword}` : match.keyword;
  const count = match.occurrences > 1 ? ` ×${match.occurrences}` : "";
  return `${term} (${MATCH_SOURCE_LABELS[match.source]}${count})`;
}

interface CategoryEditorProps {
  boutique: BoutiqueDTO;
  /** Full dictionary of selectable categories. */
  allCategories: ProductCategory[];
}

/**
 * Stage 3 admin control: shows the final product categories with their
 * provenance (auto-detected + evidence, or manually added) and lets an admin
 * add or remove categories. Every change PATCHes /api/boutiques/[id]/categories
 * and refreshes the server data.
 */
export function CategoryEditor({ boutique, allCategories }: CategoryEditorProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toAdd, setToAdd] = useState("");

  const autoById = useMemo(
    () => new Map(boutique.categoryScores.map((c) => [c.id, c])),
    [boutique.categoryScores],
  );

  const finalIds = useMemo(
    () => new Set(boutique.productCategories.map((c) => c.id)),
    [boutique.productCategories],
  );

  // Categories that can still be added: not already final, not currently removed.
  const removedIds = new Set(boutique.manualCategoriesRemoved.map((c) => c.id));
  const addable = allCategories.filter((c) => !finalIds.has(c.id) && !removedIds.has(c.id));

  async function mutate(change: { add?: string[]; remove?: string[] }) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/boutiques/${boutique.id}/categories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "Failed to update categories");
      }
      setToAdd("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update categories");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Product categories
        </div>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>

      {boutique.productCategories.length > 0 ? (
        <ul className="space-y-2">
          {boutique.productCategories.map((cat) => {
            const auto = autoById.get(cat.id);
            return (
              <li key={cat.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge variant="secondary">{cat.label}</Badge>
                {auto ? (
                  <span className="text-xs text-muted-foreground">auto · score {auto.score}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">manually added</span>
                )}
                {auto && auto.matches.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    · matched {auto.matches.map(formatMatch).join(", ")}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => mutate({ remove: [cat.id] })}
                  disabled={pending}
                  className="inline-flex items-center rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  aria-label={`Remove ${cat.label}`}
                  title={`Remove ${cat.label}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm italic text-muted-foreground">No categories detected.</p>
      )}

      {boutique.manualCategoriesRemoved.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Removed (auto-detected)
          </div>
          <ul className="flex flex-wrap gap-2">
            {boutique.manualCategoriesRemoved.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  onClick={() => mutate({ add: [cat.id] })}
                  disabled={pending}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground line-through hover:bg-muted disabled:opacity-50"
                  title={`Re-add ${cat.label}`}
                >
                  <RotateCcw className="h-3 w-3" />
                  {cat.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {addable.length > 0 ? (
        <div className="flex items-center gap-2">
          <select
            value={toAdd}
            onChange={(e) => setToAdd(e.target.value)}
            disabled={pending}
            className="h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
            aria-label="Add category"
          >
            <option value="">Add category…</option>
            {addable.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !toAdd}
            onClick={() => toAdd && mutate({ add: [toAdd] })}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
