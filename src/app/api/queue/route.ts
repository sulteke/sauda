import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { addUrlsToQueue, listQueue } from "@/services/import-queue.service";

export const dynamic = "force-dynamic";

const addSchema = z.object({ text: z.string().min(1) });

/** Protected: list the import queue. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await listQueue();
  return NextResponse.json({ data: items });
}

/** Protected: add pasted Instagram URLs (one per line) to the queue. */
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

  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await addUrlsToQueue(parsed.data.text);
  return NextResponse.json({ data: result }, { status: 201 });
}
