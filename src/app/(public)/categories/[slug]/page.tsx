import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BoutiqueGrid } from "@/features/marketplace/components/boutique-grid";
import { getCategoryBySlug } from "@/services/public-marketplace.service";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await getCategoryBySlug(slug);
  return { title: result ? result.category.name : "Category" };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getCategoryBySlug(slug);
  if (!result) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight">{result.category.name}</h1>
      <p className="text-sm text-muted-foreground">
        {result.boutiques.length} boutique{result.boutiques.length === 1 ? "" : "s"}
      </p>
      <BoutiqueGrid boutiques={result.boutiques} />
    </div>
  );
}
