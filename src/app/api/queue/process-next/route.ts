import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { processNextImport } from "@/services/import-queue.service";
import type { QueueStage } from "@/types";

export const dynamic = "force-dynamic";
// Provider calls can be slow; allow a longer execution window where supported.
export const maxDuration = 60;

const STAGES: readonly string[] = ["parse", "analyze"];

/**
 * Protected: advance the queue by ONE stage.
 *
 * With no body, the queue chooses the stage as it always has — analysis first,
 * then parsing. A `stage` of "parse" or "analyze" runs only that one, for
 * driving the two apart: scraping spends Apify credit and analysis spends time
 * on whichever model the shop is routed to, and they are worth doing at
 * different moments.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A body is optional, so a request without one stays exactly as it was.
  const body = (await request.json().catch(() => ({}))) as { stage?: unknown };
  if (body.stage !== undefined && !STAGES.includes(String(body.stage))) {
    return NextResponse.json(
      { error: `stage must be one of: ${STAGES.join(", ")}` },
      { status: 400 },
    );
  }
  const stage = body.stage === undefined ? undefined : (String(body.stage) as QueueStage);

  const result = await processNextImport(stage);
  return NextResponse.json({ data: result });
}
