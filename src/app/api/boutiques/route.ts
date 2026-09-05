import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { listBoutiques } from "@/services/boutique.service";

export const dynamic = "force-dynamic";

/** Protected: returns boutiques for the authenticated admin. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const boutiques = await listBoutiques();
  return NextResponse.json({ data: boutiques });
}
