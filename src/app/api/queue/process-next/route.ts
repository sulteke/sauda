import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { processNextImport } from "@/services/import-queue.service";

export const dynamic = "force-dynamic";
// Provider calls can be slow; allow a longer execution window where supported.
export const maxDuration = 60;

/** Protected: process the oldest PENDING queue item through the import pipeline. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processNextImport();
  return NextResponse.json({ data: result });
}
