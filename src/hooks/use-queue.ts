"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ImportQueueItemDTO } from "@/types";

const QUEUE_KEY = ["import-queue"] as const;

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

export function useQueue() {
  return useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => request<ImportQueueItemDTO[]>("/api/queue"),
  });
}

export function useAddToQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      request<{ added: number; skipped: number }>("/api/queue", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUEUE_KEY }),
  });
}

export interface ProcessResult {
  processed: boolean;
  item: ImportQueueItemDTO | null;
  remaining: number;
}

export function useProcessNext() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request<ProcessResult>("/api/queue/process-next", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUEUE_KEY }),
  });
}
