import { NextResponse } from "next/server";

import { boutiqueUpdateSchema } from "@/features/boutiques/schemas";
import { getCurrentUser } from "@/server/auth";
import {
  deleteBoutique,
  getBoutiqueById,
  isNotFoundError,
  isUniqueConstraintError,
  updateBoutique,
} from "@/services/boutique.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Protected: fetch a single boutique. */
export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const boutique = await getBoutiqueById(id);
  if (!boutique) {
    return NextResponse.json({ error: "Boutique not found" }, { status: 404 });
  }

  return NextResponse.json({ data: boutique });
}

/** Protected: update a boutique. */
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

  const parsed = boutiqueUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const boutique = await updateBoutique(id, parsed.data);
    return NextResponse.json({ data: boutique });
  } catch (error) {
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: "Boutique not found" }, { status: 404 });
    }
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A boutique with this slug already exists" },
        { status: 409 },
      );
    }
    console.error("Update boutique failed:", error);
    return NextResponse.json({ error: "Failed to update boutique" }, { status: 500 });
  }
}

/** Protected: delete a boutique. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    await deleteBoutique(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return NextResponse.json({ error: "Boutique not found" }, { status: 404 });
    }
    console.error("Delete boutique failed:", error);
    return NextResponse.json({ error: "Failed to delete boutique" }, { status: 500 });
  }
}
