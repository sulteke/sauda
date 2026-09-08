import { NextResponse } from "next/server";

import { categoryCorrectionSchema } from "@/features/boutiques/schemas";
import { getCurrentUser } from "@/server/auth";
import { applyCategoryCorrection, isNotFoundError } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Protected: Stage 3 manual category correction. Body: { add?: string[], remove?: string[] }
 * of category ids. Returns the updated boutique with recomputed categories.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = categoryCorrectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const boutique = await applyCategoryCorrection(id, parsed.data);
    return NextResponse.json({ data: boutique });
  } catch (error) {
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: "Boutique not found" }, { status: 404 });
    }
    console.error("Category correction failed:", error);
    return NextResponse.json({ error: "Failed to update categories" }, { status: 500 });
  }
}
