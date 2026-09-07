import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Instagram, Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BoutiqueGallery } from "@/features/marketplace/components/boutique-gallery";
import { getPublicBoutiqueBySlug } from "@/services/public-marketplace.service";
import { formatNumber } from "@/utils/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const boutique = await getPublicBoutiqueBySlug(slug);
  if (!boutique) return { title: "Boutique" };

  const description = boutique.bio ?? `${boutique.name} on Sauda Jasa`;
  return {
    title: boutique.name,
    description,
    openGraph: {
      title: boutique.name,
      description,
      images: boutique.avatarUrl ? [boutique.avatarUrl] : [],
      type: "profile",
    },
  };
}

export default async function PublicBoutiquePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const boutique = await getPublicBoutiqueBySlug(slug);
  if (!boutique) notFound();

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <div className="flex flex-col items-start gap-6 sm:flex-row">
        <Avatar className="h-24 w-24">
          {boutique.avatarUrl ? <AvatarImage src={boutique.avatarUrl} alt={boutique.name} /> : null}
          <AvatarFallback className="text-2xl">
            {boutique.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{boutique.name}</h1>
            {boutique.category ? <Badge variant="outline">{boutique.category}</Badge> : null}
          </div>

          {boutique.followersCount != null ? (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              {formatNumber(boutique.followersCount)} followers
            </div>
          ) : null}

          {boutique.bio ? (
            <p className="max-w-2xl whitespace-pre-line text-sm">{boutique.bio}</p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            {boutique.instagramUrl ? (
              <Button asChild>
                <a href={boutique.instagramUrl} target="_blank" rel="noopener noreferrer">
                  <Instagram className="h-4 w-4" />
                  Instagram
                </a>
              </Button>
            ) : null}
            {boutique.externalUrl ? (
              <Button variant="outline" asChild>
                <a href={boutique.externalUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Website
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {boutique.posts.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Gallery</h2>
          <BoutiqueGallery posts={boutique.posts} />
        </section>
      ) : null}
    </div>
  );
}
