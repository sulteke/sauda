import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { publishWithOverride } from "@/services/telegram.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Why the override was refused, and what to tell the admin. */
const REJECTIONS: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Boutique not found." },
  NOT_APPROVED: { status: 409, message: "Only an approved boutique can be published." },
  CITY_DETECTED: {
    status: 409,
    message: "This boutique has a detected location — override applies only to Unknown ones.",
  },
  DAILY_LIMIT_REACHED: {
    status: 429,
    message: "Daily Telegram publication limit reached. Try again tomorrow.",
  },
};

/**
 * Protected: publish a boutique whose location could not be detected, after the
 * admin confirmed in the UI that it belongs to the channel's city. Records the
 * confirmation and publishes immediately — it does NOT edit the detected city,
 * and it does NOT bypass the daily publication limit.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await publishWithOverride(id);

  if (result.rejection) {
    const { status, message } = REJECTIONS[result.rejection] ?? {
      status: 409,
      message: "Publication override refused.",
    };
    return NextResponse.json({ error: message }, { status });
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Telegram publication failed." },
      { status: 502 },
    );
  }

  return NextResponse.json({ data: result });
}
