import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BadgeCheck,
  Clock,
  ExternalLink,
  Grid3x3,
  Heart,
  ImageOff,
  Images,
  Instagram,
  Link2,
  MapPin,
  MessageCircle,
  Pin,
  Play,
  Store,
  Tag,
  UserPlus,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CategoryEditor } from "@/features/boutiques/components/category-editor";
import { BOUTIQUE_STATUS_LABELS } from "@/features/boutiques/schemas";
import { ALL_PRODUCT_CATEGORIES } from "@/lib/category-engine";
import type { BoutiqueDTO, BoutiquePost, InstagramBusinessAddress } from "@/types";
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

/** Composes a one-line, human-readable address from the parts that are present. */
function formatAddress(address: InstagramBusinessAddress): string {
  return [address.streetAddress, address.cityName, address.zipCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function PostTile({ post }: { post: BoutiquePost }) {
  const isVideo = Boolean(post.videoUrl) || post.type === "Video";
  const isCarousel = (post.childPosts?.length ?? 0) > 0 || post.type === "Sidecar";

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

  const overlay = (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2">
        {post.isPinned ? (
          <span className="rounded-full bg-black/60 p-1 text-white" title="Pinned">
            <Pin className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span />
        )}
        {isVideo ? (
          <span className="rounded-full bg-black/60 p-1 text-white" title="Video">
            <Play className="h-3.5 w-3.5" />
          </span>
        ) : isCarousel ? (
          <span className="rounded-full bg-black/60 p-1 text-white" title="Carousel">
            <Images className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1 bg-gradient-to-t from-black/70 to-transparent p-2 text-[11px] text-white">
        {post.locationName ? (
          <div className="flex items-center gap-1 truncate">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{post.locationName}</span>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          {post.likes != null ? (
            <span className="flex items-center gap-1">
              <Heart className="h-3 w-3" />
              {formatNumber(post.likes)}
            </span>
          ) : null}
          {post.comments != null ? (
            <span className="flex items-center gap-1">
              <MessageCircle className="h-3 w-3" />
              {formatNumber(post.comments)}
            </span>
          ) : null}
        </div>
      </div>
    </>
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
        {overlay}
      </a>
    );
  }

  return (
    <div className={className}>
      {media}
      {overlay}
    </div>
  );
}

export function BoutiqueDetails({ boutique }: { boutique: BoutiqueDTO }) {
  const posts = boutique.posts.slice(0, 6);
  const importedAt = boutique.lastImportedAt ?? boutique.createdAt;
  const address = boutique.businessAddress;
  const addressLine = address ? formatAddress(address) : "";
  // The single `externalUrl` is already shown as "Website"; list any extras here.
  const extraLinks = boutique.externalUrls.filter((link) => link.url !== boutique.externalUrl);

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
              {boutique.isVerified ? (
                <Badge variant="secondary" className="gap-1">
                  <BadgeCheck className="h-3.5 w-3.5 text-sky-500" />
                  Verified
                </Badge>
              ) : null}
              {boutique.isBusinessAccount ? (
                <Badge variant="secondary" className="gap-1">
                  <Store className="h-3.5 w-3.5" />
                  Business
                </Badge>
              ) : null}
              {boutique.isPrivate ? <Badge variant="outline">Private</Badge> : null}
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
            <InfoRow icon={UserPlus} label="Following">
              {boutique.followsCount != null ? formatNumber(boutique.followsCount) : "—"}
            </InfoRow>
            <InfoRow icon={Grid3x3} label="Posts">
              {boutique.postsCount != null ? formatNumber(boutique.postsCount) : "—"}
            </InfoRow>
            <InfoRow icon={Link2} label="Website">
              {boutique.externalUrl ? (
                <a
                  href={boutique.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {hostOf(boutique.externalUrl)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                "—"
              )}
            </InfoRow>
            <InfoRow icon={Clock} label="Last import">
              {formatDate(importedAt)}
            </InfoRow>
            {addressLine ? (
              <InfoRow icon={MapPin} label="Business address">
                {addressLine}
              </InfoRow>
            ) : null}
          </div>

          <CategoryEditor boutique={boutique} allCategories={ALL_PRODUCT_CATEGORIES} />

          {extraLinks.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Links</div>
              <ul className="flex flex-wrap gap-2">
                {extraLinks.map((link) => (
                  <li key={link.url}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-primary hover:bg-muted"
                    >
                      {link.title?.trim() || hostOf(link.url)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
