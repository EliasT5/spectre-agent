"use client";

import { create } from "zustand";

export type ReaderSlot = "A" | "B";

interface LibraryState {
  openSet: Record<ReaderSlot, string | null>;
  focused: ReaderSlot;
  threadId: string | null;
  open: (slot: ReaderSlot, pdfId: string) => void;
  close: (slot: ReaderSlot) => void;
  closeAll: () => void;
  focus: (slot: ReaderSlot) => void;
  setThreadId: (id: string | null) => void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  openSet: { A: null, B: null },
  focused: "A",
  threadId: null,
  open: (slot, pdfId) => {
    const next = { ...get().openSet, [slot]: pdfId };
    set({ openSet: next, focused: slot, threadId: null });
  },
  close: (slot) => {
    const next = { ...get().openSet, [slot]: null };
    const stillOpen = next.A || next.B;
    set({
      openSet: next,
      threadId: stillOpen ? get().threadId : null,
      focused: next[get().focused] ? get().focused : (next.A ? "A" : "B"),
    });
  },
  closeAll: () => set({ openSet: { A: null, B: null }, threadId: null, focused: "A" }),
  focus: (slot) => set({ focused: slot }),
  setThreadId: (id) => set({ threadId: id }),
}));

export function selectPdfIds(state: { openSet: Record<ReaderSlot, string | null> }): string[] {
  return [state.openSet.A, state.openSet.B].filter((x): x is string => !!x);
}
