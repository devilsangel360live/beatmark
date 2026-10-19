import { create } from "zustand";

export type StatusKind = "info" | "warning" | "error";

interface StatusState {
  message: { text: string; kind: StatusKind; id: number } | null;
  show(text: string, kind?: StatusKind): void;
  clear(): void;
}

let nextId = 0;

/** One-line, non-modal feedback shown in the status bar. */
export const useStatus = create<StatusState>((set) => ({
  message: null,
  show: (text, kind = "info") => set({ message: { text, kind, id: ++nextId } }),
  clear: () => set({ message: null }),
}));

export const showStatus = (text: string, kind?: StatusKind) => useStatus.getState().show(text, kind);

export function showError(e: unknown): void {
  showStatus(e instanceof Error ? e.message : String(e), "error");
}
