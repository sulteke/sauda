"use client";

import { create } from "zustand";

interface UIState {
  /** Global search query typed in the top navbar, consumed by list views. */
  searchQuery: string;
  setSearchQuery: (value: string) => void;
}

/** Global client-only UI state. */
export const useUIStore = create<UIState>((set) => ({
  searchQuery: "",
  setSearchQuery: (value) => set({ searchQuery: value }),
}));
