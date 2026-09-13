import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { retryQueueItem } from "@/services/import-queue.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Protected: re-queue a failed item for its own stage. PARSE_FAILED re-scrapes;
 * ANALYSIS_FAILED re-runs Gemini only (never re-scrapes).
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const item = await retryQueueItem(id);
    return NextResponse.json({ data: item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to retry queue item";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
