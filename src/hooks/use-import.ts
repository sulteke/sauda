"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ImportJobDTO } from "@/types";

interface ApiResult<T> {
  data?: T;
  error?: string;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult<T>;
  if (!res.ok) {
    throw new Error(json.error ?? "Request failed");
  }
  return json.data as T;
}

/** Paste URL -> create job -> run discovery -> return preview. */
export function useAnalyzeImport() {
  return useMutation({
    mutationFn: (url: string) => post<ImportJobDTO>("/api/import/analyze", { url }),
  });
}

/** Persist the reviewed preview as a boutique. */
export function useSaveImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      post<{ job: ImportJobDTO; boutiqueId: string }>(`/api/import/${jobId}/save`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["boutiques"] }),
  });
}
