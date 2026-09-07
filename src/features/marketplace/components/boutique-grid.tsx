import type { ReactNode } from "react";

import { BoutiqueCard } from "@/features/marketplace/components/boutique-card";
import type { BoutiqueDTO } from "@/types";

export function BoutiqueGrid({
  boutiques,
  empty,
}: {
  boutiques: BoutiqueDTO[];
  empty?: ReactNode;
}) {
  if (boutiques.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        {empty ?? "No boutiques yet."}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {boutiques.map((boutique) => (
        <BoutiqueCard key={boutique.id} boutique={boutique} />
      ))}
    </div>
  );
}
