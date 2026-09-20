import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { backfillBoutiqueHashtags } from "@/services/hashtag-backfill.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Protected: fill `hashtags` for boutiques that have none, deterministically.
 *
 * Calls NO model, so it never touches the daily AI allowance, and it writes
 * only the `hashtags` column. Idempotent — boutiques that already have
 * hashtags are skipped, so it is safe to re-run.
 *
 * POST /api/boutiques/hashtags/backfill?dryRun=true reports what WOULD change
 * without writing anything; run that first to review a production pass.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const result = await backfillBoutiqueHashtags({ dryRun });
  return NextResponse.json({ data: { dryRun, ...result } });
}
