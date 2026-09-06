import { NextResponse } from "next/server";

import { boutiqueInputSchema } from "@/features/boutiques/schemas";
import { getCurrentUser } from "@/server/auth";
import {
  createBoutique,
  isUniqueConstraintError,
  listBoutiques,
} from "@/services/boutique.service";

export const dynamic = "force-dynamic";

/** Protected: list boutiques for the authenticated admin. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const boutiques = await listBoutiques();
  return NextResponse.json({ data: boutiques });
}

/** Protected: create a boutique. */
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

  const parsed = boutiqueInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const boutique = await createBoutique(parsed.data);
    return NextResponse.json({ data: boutique }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A boutique with this slug already exists" },
        { status: 409 },
      );
    }
    console.error("Create boutique failed:", error);
    return NextResponse.json({ error: "Failed to create boutique" }, { status: 500 });
  }
}
