"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { BoutiqueInput } from "@/features/boutiques/schemas";
import type { BoutiqueDTO } from "@/types";

const BOUTIQUES_KEY = ["boutiques"] as const;

interface ApiResult<T> {
  data?: T;
  error?: string;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult<T>;
  if (!res.ok) {
    throw new Error(json.error ?? "Request failed");
  }
  return json.data as T;
}

/** Client hook: fetches boutiques from the protected route handler. */
export function useBoutiques() {
  return useQuery({
    queryKey: BOUTIQUES_KEY,
    queryFn: () => request<BoutiqueDTO[]>("/api/boutiques"),
  });
}

export function useCreateBoutique() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BoutiqueInput) =>
      request<BoutiqueDTO>("/api/boutiques", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BOUTIQUES_KEY }),
  });
}

export function useUpdateBoutique() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BoutiqueInput }) =>
      request<BoutiqueDTO>(`/api/boutiques/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BOUTIQUES_KEY }),
  });
}

export function useDeleteBoutique() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/boutiques/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as ApiResult<never>;
        throw new Error(json.error ?? "Failed to delete boutique");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BOUTIQUES_KEY }),
  });
}
