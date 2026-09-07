import type { MetadataRoute } from "next";

import { listCategories, listRecentBoutiques } from "@/services/public-marketplace.service";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [boutiques, categories] = await Promise.all([listRecentBoutiques(1000), listCategories()]);

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: "daily", priority: 1 },
    { url: `${BASE_URL}/categories`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${BASE_URL}/search`, changeFrequency: "monthly", priority: 0.3 },
  ];

  const boutiqueEntries: MetadataRoute.Sitemap = boutiques.map((boutique) => ({
    url: `${BASE_URL}/boutique/${boutique.slug}`,
    lastModified: boutique.updatedAt,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${BASE_URL}/categories/${category.slug}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [...staticEntries, ...boutiqueEntries, ...categoryEntries];
}
