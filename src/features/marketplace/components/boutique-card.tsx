import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import type { BoutiqueDTO } from "@/types";
import { formatNumber } from "@/utils/format";

export function BoutiqueCard({ boutique }: { boutique: BoutiqueDTO }) {
  const meta = [
    boutique.category ?? "Boutique",
    boutique.followersCount != null ? `${formatNumber(boutique.followersCount)} followers` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link href={`/boutique/${boutique.slug}`} className="group block">
      <Card className="h-full transition-shadow group-hover:shadow-md">
        <CardContent className="flex items-center gap-3 p-4">
          <Avatar className="h-12 w-12">
            {boutique.avatarUrl ? (
              <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
            ) : null}
            <AvatarFallback>{boutique.name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate font-medium group-hover:underline">{boutique.name}</div>
            <div className="truncate text-xs text-muted-foreground">{meta}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
