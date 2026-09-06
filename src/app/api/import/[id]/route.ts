import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { getImportJob } from "@/services/import.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Protected: read an import job's current status/preview (supports future polling). */
export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await getImportJob(id);
  if (!job) {
    return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  }

  return NextResponse.json({ data: job });
}
