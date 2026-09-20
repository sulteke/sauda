import type { ReactNode } from "react";
import { CheckCircle2, Clock, SkipForward, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FailedBoutiqueCard } from "@/features/telegram/components/failed-boutique-card";
import { SkippedBoutiqueCard } from "@/features/telegram/components/skipped-boutique-card";
import type { BoutiqueDTO } from "@/types";

/** Shared card shell with a title, an icon, and a count badge. */
function ColumnShell({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count: number;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">{count}</span>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function Column({
  title,
  icon,
  items,
}: {
  title: string;
  icon: LucideIcon;
  items: BoutiqueDTO[];
}) {
  return (
    <ColumnShell title={title} icon={icon} count={items.length}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        items.map((boutique) => (
          <div key={boutique.id} className="flex items-start gap-2 rounded-md border p-2">
            <Avatar className="h-8 w-8">
              {boutique.avatarUrl ? (
                <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
              ) : null}
              <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{boutique.name}</div>
              {boutique.category ? (
                <div className="truncate text-xs text-muted-foreground">{boutique.category}</div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </ColumnShell>
  );
}

/** Skipped column — shows the detected city, and offers the Unknown-only override. */
function SkippedColumn({ items }: { items: BoutiqueDTO[] }) {
  return (
    <ColumnShell title="Skipped (not Almaty)" icon={SkipForward} count={items.length}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        items.map((boutique) => <SkippedBoutiqueCard key={boutique.id} boutique={boutique} />)
      )}
    </ColumnShell>
  );
}

/** Failed column — compact cards with a "View details" modal per boutique. */
function FailedColumn({ items }: { items: BoutiqueDTO[] }) {
  return (
    <ColumnShell title="Failed" icon={XCircle} count={items.length}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        items.map((boutique) => <FailedBoutiqueCard key={boutique.id} boutique={boutique} />)
      )}
    </ColumnShell>
  );
}

export function TelegramBoard({
  pending,
  published,
  skipped,
  failed,
}: {
  pending: BoutiqueDTO[];
  published: BoutiqueDTO[];
  skipped: BoutiqueDTO[];
  failed: BoutiqueDTO[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <Column title="Pending publications" icon={Clock} items={pending} />
      <Column title="Published" icon={CheckCircle2} items={published} />
      <SkippedColumn items={skipped} />
      <FailedColumn items={failed} />
    </div>
  );
}
