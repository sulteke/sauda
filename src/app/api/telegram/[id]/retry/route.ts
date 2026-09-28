import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { retryFailedPublication } from "@/services/telegram.service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Why the retry was refused, and what to tell the admin. */
const REJECTIONS: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Boutique not found." },
  NOT_APPROVED: { status: 409, message: "Only an approved boutique can be published." },
  NOT_FAILED: {
    status: 409,
    message: "Only a FAILED publication can be retried.",
  },
};

/**
 * Protected: move a failed publication back to pending so Publish Queue picks
 * it up again. Requeues only — nothing is sent to the channel from here, and
 * the daily limit still applies when the queue runs.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await retryFailedPublication(id);

  if (result.rejection) {
    const { status, message } = REJECTIONS[result.rejection] ?? {
      status: 409,
      message: "Retry refused.",
    };
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ data: result });
}
