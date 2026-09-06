import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  ImageOff,
  Instagram,
  Link2,
  Tag,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BOUTIQUE_STATUS_LABELS } from "@/features/boutiques/schemas";
import type { BoutiqueDTO, BoutiquePost } from "@/types";
import { formatDate, formatNumber } from "@/utils/format";

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate text-sm">{children}</div>
      </div>
    </div>
  );
}

function PostTile({ post }: { post: BoutiquePost }) {
  const media = post.imageUrl ? (
    // Instagram CDN images — plain <img> avoids next/image remote config + proxying.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={post.imageUrl}
      alt={post.caption ?? "Instagram post"}
      loading="lazy"
      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
      <ImageOff className="h-6 w-6" />
    </div>
  );

  const className = "group relative block aspect-square overflow-hidden rounded-lg border bg-muted";

  if (post.permalink) {
    return (
      <a
        href={post.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={post.caption ?? undefined}
      >
        {media}
      </a>
    );
  }

  return <div className={className}>{media}</div>;
}

export function BoutiqueDetails({ boutique }: { boutique: BoutiqueDTO }) {
  const posts = boutique.posts.slice(0, 6);
  const importedAt = boutique.lastImportedAt ?? boutique.createdAt;

  return (
    <div className="space-y-6">
      <Link
        href="/boutiques"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to boutiques
      </Link>

      <Card>
        <CardHeader className="flex flex-row items-start gap-4 space-y-0">
          <Avatar className="h-16 w-16">
            {boutique.avatarUrl ? (
              <AvatarImage src={boutique.avatarUrl} alt={boutique.name} />
            ) : null}
            <AvatarFallback className="text-xl">
              {boutique.name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{boutique.name}</h1>
              <Badge variant="outline">{BOUTIQUE_STATUS_LABELS[boutique.status]}</Badge>
            </div>
            {boutique.instagramHandle ? (
              <a
                href={
                  boutique.instagramUrl ?? `https://www.instagram.com/${boutique.instagramHandle}/`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <Instagram className="h-4 w-4" />@{boutique.instagramHandle}
              </a>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {boutique.bio ? (
            <p className="max-w-2xl whitespace-pre-line text-sm text-foreground">{boutique.bio}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">No bio captured.</p>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoRow icon={Tag} label="Category">
              {boutique.category ?? "—"}
            </InfoRow>
            <InfoRow icon={Users} label="Followers">
              {boutique.followersCount != null ? formatNumber(boutique.followersCount) : "—"}
            </InfoRow>
            <InfoRow icon={Link2} label="Website">
              {boutique.externalUrl ? (
                <a
                  href={boutique.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {boutique.externalUrl.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow icon={Clock} label="Last import">
              {formatDate(importedAt)}
            </InfoRow>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Recent posts</h2>
        {posts.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {posts.map((post, index) => (
              <PostTile key={post.permalink ?? index} post={post} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No imported posts for this boutique.
          </div>
        )}
      </section>
    </div>
  );
}
