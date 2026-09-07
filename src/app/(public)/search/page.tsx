import type { Metadata } from "next";

import { BoutiqueGrid } from "@/features/marketplace/components/boutique-grid";
import { SearchBar } from "@/features/marketplace/components/search-bar";
import { searchPublicBoutiques } from "@/services/public-marketplace.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const results = query ? await searchPublicBoutiques(query) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight">Search</h1>
      <div className="max-w-xl">
        <SearchBar defaultValue={query} />
      </div>

      {query ? (
        <>
          <p className="text-sm text-muted-foreground">
            {results.length} result{results.length === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
          </p>
          <BoutiqueGrid boutiques={results} empty={`No boutiques found for “${query}”.`} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Type a boutique name or Instagram handle to search.
        </p>
      )}
    </div>
  );
}
