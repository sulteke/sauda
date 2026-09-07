import { ImageOff } from "lucide-react";

import type { BoutiquePost } from "@/types";

const TILE_CLASS = "group relative block aspect-square overflow-hidden rounded-lg border bg-muted";

export function BoutiqueGallery({ posts }: { posts: BoutiquePost[] }) {
  const items = posts.slice(0, 6);
  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((post, index) => {
        const key = post.permalink ?? `post-${index}`;
        const media = post.imageUrl ? (
          // Instagram CDN images — plain <img> avoids next/image remote config.
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

        if (post.permalink) {
          return (
            <a
              key={key}
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className={TILE_CLASS}
              title={post.caption ?? undefined}
            >
              {media}
            </a>
          );
        }
        return (
          <div key={key} className={TILE_CLASS}>
            {media}
          </div>
        );
      })}
    </div>
  );
}
