"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DiscoveryCandidateDTO } from "@/types";

const CANDIDATES_KEY = ["discovery-candidates"] as const;

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

export interface DiscoveryRunResult {
  seedType: "PROFILE" | "HASHTAG";
  seedValue: string;
  found: number;
  added: number;
}

export function useDiscoveryCandidates() {
  return useQuery({
    queryKey: CANDIDATES_KEY,
    queryFn: () => request<DiscoveryCandidateDTO[]>("/api/discovery"),
  });
}

export function useRunDiscovery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seed: string) =>
      request<DiscoveryRunResult>("/api/discovery", {
        method: "POST",
        body: JSON.stringify({ seed }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY }),
  });
}

export function useQueueCandidates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      request<{ queued: number }>("/api/discovery/queue", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY }),
  });
}

export function useDismissCandidates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      request<{ dismissed: number }>("/api/discovery/dismiss", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY }),
  });
}
