"use client";

import { useQuery } from "@tanstack/react-query";

import type { BoutiqueDTO } from "@/types";

async function fetchBoutiques(): Promise<BoutiqueDTO[]> {
  const res = await fetch("/api/boutiques");
  if (!res.ok) {
    throw new Error("Failed to load boutiques");
  }
  const json = (await res.json()) as { data: BoutiqueDTO[] };
  return json.data;
}

/** Client hook: fetches boutiques from the protected route handler. */
export function useBoutiques() {
  return useQuery({
    queryKey: ["boutiques"],
    queryFn: fetchBoutiques,
  });
}
