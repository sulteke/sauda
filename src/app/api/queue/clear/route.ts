import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { clearQueue } from "@/services/import-queue.service";

export const dynamic = "force-dynamic";

const clearSchema = z.object({ scope: z.enum(["COMPLETED", "FAILED", "ALL"]) });

/** Protected: bulk-delete queue items by scope (COMPLETED / FAILED / ALL). */
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

  const parsed = clearSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await clearQueue(parsed.data.scope);
  return NextResponse.json({ data: result });
}
