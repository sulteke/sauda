import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { queueCandidates } from "@/services/discovery.service";

export const dynamic = "force-dynamic";

const schema = z.object({ ids: z.array(z.string()).min(1) });

/** Protected: send selected candidates into the existing import queue. */
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
    return NextResponse.json({ error: "Validation failed" }, { status: 422 });
  }

  const result = await queueCandidates(parsed.data.ids);
  return NextResponse.json({ data: result });
}
