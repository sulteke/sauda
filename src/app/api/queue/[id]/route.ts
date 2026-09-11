import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { deleteQueueItem } from "@/services/import-queue.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Protected: permanently delete one queue item (any status). */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await deleteQueueItem(id);
  return NextResponse.json({ data: result });
}
