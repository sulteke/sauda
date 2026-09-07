import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BoutiqueGrid } from "@/features/marketplace/components/boutique-grid";
import { SearchBar } from "@/features/marketplace/components/search-bar";
import {
  listCategories,
  listFeaturedBoutiques,
  listRecentBoutiques,
} from "@/services/public-marketplace.service";

export const dynamic = "force-dynamic";

function SectionHeading({ title, href }: { title: string; href?: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {href ? (
        <Link href={href} className="text-sm text-primary hover:underline">
          View all
        </Link>
      ) : null}
    </div>
  );
}

export default async function HomePage() {
  const [featured, recent, categories] = await Promise.all([
    listFeaturedBoutiques(6),
    listRecentBoutiques(8),
    listCategories(),
  ]);

  return (
    <>
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-24">
          <h1 className="mx-auto max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
            Discover Almaty&apos;s boutiques
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Find local shops and brands — browse by category, or search by name or Instagram handle.
          </p>
          <div className="mx-auto mt-8 max-w-xl">
            <SearchBar />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-12 px-4 py-12">
        {categories.length > 0 ? (
          <section className="space-y-4">
            <SectionHeading title="Browse categories" href="/categories" />
            <div className="flex flex-wrap gap-2">
              {categories.slice(0, 12).map((category) => (
                <Link key={category.slug} href={`/categories/${category.slug}`}>
                  <Badge
                    variant="outline"
                    className="cursor-pointer px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    {category.name}
                    <span className="ml-1.5 text-muted-foreground">{category.count}</span>
                  </Badge>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-4">
          <SectionHeading title="Featured boutiques" />
          <BoutiqueGrid
            boutiques={featured}
            empty="No boutiques published yet — check back soon."
          />
        </section>

        {recent.length > 0 ? (
          <section className="space-y-4">
            <SectionHeading title="Recently added" />
            <BoutiqueGrid boutiques={recent} />
          </section>
        ) : null}
      </div>
    </>
  );
}
