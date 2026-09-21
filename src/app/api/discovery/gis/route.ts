import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { GisLocationError, GisSourceError } from "@/server/discovery/gis/gis-store-source";
import { runGisDiscovery } from "@/services/gis-discovery.service";

export const dynamic = "force-dynamic";
// Enumerating a large venue is several sequential 2GIS pages; Fluid Compute
// allows up to 300s, and each page is bounded by its own request timeout.
export const maxDuration = 300;

const schema = z.object({
  location: z.string().min(1),
  /** Optional cap, so a new venue can be verified cheaply before a full pass. */
  limit: z.number().int().positive().max(2000).optional(),
  locationName: z.string().optional(),
});

/**
 * Protected: enumerate the businesses at a 2GIS venue and turn the ones with a
 * reliable Instagram account into discovery candidates.
 *
 * Creates candidates ONLY — no scraping, no AI, no publishing. Those stay with
 * the existing pipeline, which the admin triggers separately.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const result = await runGisDiscovery(parsed.data.location, {
      limit: parsed.data.limit,
      locationName: parsed.data.locationName ?? null,
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof GisLocationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof GisSourceError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("2GIS discovery failed:", error);
    return NextResponse.json({ error: "2GIS discovery failed" }, { status: 500 });
  }
}
