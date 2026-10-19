import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import { create } from "zustand";
import { createDemoProject, type Layout, type Practice, type Project } from "../core/project";
import type { NoteDuration } from "../core/time";

enablePatches();

export type Selection =
  | { kind: "notes"; ids: string[] }
  | { kind: "measures"; start: number; end: number }
  | null;

interface HistoryEntry {
  label: string;
  redo: Patch[];
  undo: Patch[];
}

const HISTORY_LIMIT = 200;

interface EditorState {
  project: Project;
  /** Where the project was last saved; null for a never-saved project. */
  filePath: string | null;
  dirty: boolean;
  selection: Selection;
  noteInput: boolean;
  inputDuration: NoteDuration;
  past: HistoryEntry[];
  future: HistoryEntry[];

  /** Undoable change to score, instrument map or layout. Returns the recipe's result. */
  edit<T>(label: string, recipe: (p: Draft<Project>) => T): T;
  undo(): void;
  redo(): void;
  /** Practice settings (tempo, loop, count-in) are saved but not undoable. */
  setPractice(change: Partial<Practice>): void;
  /** View settings (zoom, measures per system) are saved but not undoable. */
  setLayout(change: Partial<Layout>): void;
  load(project: Project, filePath: string | null): void;
  markSaved(filePath: string): void;
  select(s: Selection): void;
  setNoteInput(on: boolean): void;
  setInputDuration(d: NoteDuration): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createDemoProject(),
  filePath: null,
  dirty: false,
  selection: null,
  noteInput: false,
  inputDuration: { value: "8", dots: 0 },
  past: [],
  future: [],

  edit(label, recipe) {
    let result!: ReturnType<typeof recipe>;
    const [project, redo, undo] = produceWithPatches(get().project, (draft) => {
      result = recipe(draft);
    });
    if (redo.length === 0) return result;
    set((s) => ({
      project,
      dirty: true,
      past: [...s.past, { label, redo, undo }].slice(-HISTORY_LIMIT),
      future: [],
    }));
    return result;
  },

  undo() {
    const { past, project } = get();
    const entry = past[past.length - 1];
    if (!entry) return;
    set((s) => ({
      project: applyPatches(project, entry.undo),
      past: past.slice(0, -1),
      future: [entry, ...s.future],
      dirty: true,
      selection: null,
    }));
  },

  redo() {
    const { future, project } = get();
    const entry = future[0];
    if (!entry) return;
    set((s) => ({
      project: applyPatches(project, entry.redo),
      past: [...s.past, entry],
      future: future.slice(1),
      dirty: true,
      selection: null,
    }));
  },

  setPractice(change) {
    set((s) => ({ project: { ...s.project, practice: { ...s.project.practice, ...change } }, dirty: true }));
  },

  setLayout(change) {
    set((s) => ({ project: { ...s.project, layout: { ...s.project.layout, ...change } }, dirty: true }));
  },

  load(project, filePath) {
    set({ project, filePath, dirty: false, selection: null, past: [], future: [] });
  },

  markSaved(filePath) {
    set({ filePath, dirty: false });
  },

  select(selection) {
    set({ selection });
  },
  setNoteInput(noteInput) {
    set({ noteInput });
  },
  setInputDuration(inputDuration) {
    set({ inputDuration });
  },
}));

export function selectedNoteIds(s: Selection): string[] {
  return s?.kind === "notes" ? s.ids : [];
}
