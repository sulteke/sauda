import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { processNextTelegramPost } from "@/services/telegram.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Protected: publish the oldest READY_TO_PUBLISH boutique to Telegram. */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processNextTelegramPost();
  return NextResponse.json({ data: result });
}
