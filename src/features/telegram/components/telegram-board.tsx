import { CheckCircle2, Clock, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BoutiqueDTO } from "@/types";

function Column({
  title,
  icon: Icon,
  items,
  showError = false,
}: {
  title: string;
  icon: LucideIcon;
  items: BoutiqueDTO[];
  showError?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
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
                {showError && boutique.telegramError ? (
                  <div className="truncate text-xs text-destructive">{boutique.telegramError}</div>
                ) : boutique.category ? (
                  <div className="truncate text-xs text-muted-foreground">{boutique.category}</div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function TelegramBoard({
  pending,
  published,
  failed,
}: {
  pending: BoutiqueDTO[];
  published: BoutiqueDTO[];
  failed: BoutiqueDTO[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Column title="Pending publications" icon={Clock} items={pending} />
      <Column title="Published" icon={CheckCircle2} items={published} />
      <Column title="Failed" icon={XCircle} items={failed} showError />
    </div>
  );
}
