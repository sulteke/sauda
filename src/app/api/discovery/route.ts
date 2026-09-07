import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import {
  DiscoveryNotFoundError,
  DiscoveryPrivateAccountError,
  DiscoveryProviderError,
  DiscoveryValidationError,
} from "@/server/discovery/errors";
import { listCandidates, runDiscovery } from "@/services/discovery.service";

export const dynamic = "force-dynamic";

const runSchema = z.object({ seed: z.string().min(1) });

/** Protected: list candidates awaiting review. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await listCandidates();
  return NextResponse.json({ data: items });
}

/** Protected: run discovery for a seed (profile or hashtag). */
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

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  try {
    const result = await runDiscovery(parsed.data.seed);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (
      error instanceof DiscoveryValidationError ||
      error instanceof DiscoveryPrivateAccountError
    ) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof DiscoveryNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof DiscoveryProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("Discovery failed:", error);
    return NextResponse.json({ error: "Discovery failed" }, { status: 500 });
  }
}
