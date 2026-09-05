"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Signs the current admin out and returns them to the login screen. */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
