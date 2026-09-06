import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { ImportStateError } from "@/server/import/errors";
import { saveBoutiqueFromImport } from "@/services/import.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Protected: persist a reviewed import job as a boutique. */
export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const result = await saveBoutiqueFromImport(id);
    return NextResponse.json({ data: result });
  } catch (error) {
    if (error instanceof ImportStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Import save failed:", error);
    return NextResponse.json({ error: "Failed to save boutique" }, { status: 500 });
  }
}
