import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Keep the admin panel and APIs out of search indexes.
        disallow: [
          "/api",
          "/login",
          "/dashboard",
          "/discovery",
          "/import",
          "/queue",
          "/boutiques",
          "/review-queue",
          "/telegram",
          "/settings",
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
