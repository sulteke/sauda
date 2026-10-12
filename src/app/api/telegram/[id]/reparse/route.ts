import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { refreshPublicationImages } from "@/services/telegram.service";

export const dynamic = "force-dynamic";
// The scrape runs two Apify actors (with retries) and copies the images; the
// discovery routes allow the same window for the same kind of work.
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

/** Why the re-parse was refused, and what to tell the admin. */
const REJECTIONS: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Boutique not found." },
  NOT_APPROVED: { status: 409, message: "Only an approved boutique can be published." },
  NOT_FAILED: { status: 409, message: "Only a failed publication can be re-parsed from here." },
  NO_INSTAGRAM: { status: 409, message: "This boutique has no Instagram link to re-parse." },
  DIFFERENT_PROFILE: {
    status: 409,
    message:
      "The Instagram link now leads to a different profile (renamed or moved). Check the boutique by hand.",
  },
  STILL_EXPIRED: {
    status: 409,
    message: "Re-parsed, but Instagram returned no live images for this profile.",
  },
};

/**
 * Protected: scrape a failed boutique's Instagram profile again for fresh image
 * links, then move it back to pending. Costs one Apify run. Requeues only —
 * nothing is sent to the channel from here.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const result = await refreshPublicationImages(id);
    if (result.rejection) {
      const { status, message } = REJECTIONS[result.rejection] ?? {
        status: 409,
        message: "Re-parse refused.",
      };
      return NextResponse.json({ error: message }, { status });
    }
    return NextResponse.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Re-parse failed";
    return NextResponse.json({ error: `Re-parse failed: ${message}` }, { status: 502 });
  }
}
