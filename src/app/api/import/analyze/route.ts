import { NextResponse } from "next/server";

import { importUrlSchema } from "@/features/import/schemas";
import { getCurrentUser } from "@/server/auth";
import { ImportValidationError } from "@/server/import/errors";
import { analyzeInstagramProfile } from "@/services/import.service";

export const dynamic = "force-dynamic";

/** Protected: create an import job and run discovery, returning the preview. */
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

  const parsed = importUrlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const job = await analyzeInstagramProfile({ url: parsed.data.url, userId: user.id });
    return NextResponse.json({ data: job }, { status: 201 });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("Import analyze failed:", error);
    return NextResponse.json({ error: "Failed to analyze profile" }, { status: 500 });
  }
}
