import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { parseProject } from "./core/project";
import { autosave, clearRecovery, inDesktopApp, newProjectWorkspace, takeRecovery } from "./io/backend";
import { useEditor } from "./store/editor";
import {
  changeInstrument,
  deleteSelection,
  newProject,
  nudge,
  openProjectFile,
  restart,
  saveProjectFile,
  setZoom,
  shiftInstrument,
  stop,
  toggleArticulation,
  toggleDot,
  toggleLoop,
  togglePlay,
  changeDuration,
} from "./ui/actions";
import { DURATION_KEYS, Inspector } from "./ui/Inspector";
import { ScoreView } from "./ui/ScoreView";
import { SourcePanel } from "./ui/SourcePanel";
import { showError, useStatus } from "./ui/status";
import { Toolbar } from "./ui/Toolbar";
import { Transport } from "./ui/Transport";
import { engine } from "./playback/engine";
import "./App.css";

const AUTOSAVE_DELAY_MS = 1500;

export default function App() {
  const [sourceOpen, setSourceOpen] = useState(true);
  useKeyboardShortcuts();
  useAutosave();
  useRecoveryPrompt();

  return (
    <div className={`app${sourceOpen ? "" : " source-collapsed"}`}>
      <Toolbar />
      {sourceOpen ? (
        <SourcePanel onCollapse={() => setSourceOpen(false)} />
      ) : (
        <button className="source-reveal" onClick={() => setSourceOpen(true)} title="Show source panel" aria-label="Show source panel">
          ⟩
        </button>
      )}
      <main className="score-area">
        <ScoreView />
      </main>
      <Inspector />
      <Transport />
      <StatusBar />
    </div>
  );
}

function StatusBar() {
  const message = useStatus((s) => s.message);
  const clear = useStatus((s) => s.clear);
  useEffect(() => {
    if (!message || message.kind === "error") return;
    const t = window.setTimeout(clear, 8000);
    return () => window.clearTimeout(t);
  }, [message?.id]);
  if (!message) return <div className="status" />;
  const icon = message.kind === "error" ? "⚠ " : message.kind === "warning" ? "! " : "";
  return (
    <div className={`status ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
      <span>
        {icon}
        {message.text}
      </span>
      <button className="icon" onClick={clear} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useEditor.getState();
      const k = e.key.toLowerCase();

      if (mod) {
        const handled: Record<string, () => void> = {
          z: () => (e.shiftKey ? s.redo() : s.undo()),
          y: () => s.redo(),
          s: () => void saveProjectFile(e.shiftKey),
          o: () => void openProjectFile(),
          n: () => void newProject(),
        };
        if (handled[k]) {
          e.preventDefault();
          handled[k]();
        }
        return;
      }
      if (isTyping(e.target)) return;

      const hasNotes = s.selection?.kind === "notes";
      const instrument = s.project.instrumentMap.find((d) => d.shortcut === k);
      let handled = true;
      if (e.key === " ") void togglePlay();
      else if (e.key === "Escape") {
        if (s.noteInput) s.setNoteInput(false);
        else if (engine.state !== "stopped") stop();
        else s.select(null);
      } else if (e.key === "Home") void restart();
      else if (k === "n") s.setNoteInput(!s.noteInput);
      else if (DURATION_KEYS[e.key]) changeDuration({ value: DURATION_KEYS[e.key], dots: 0 });
      else if (e.key === ".") toggleDot();
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowUp") shiftInstrument(1);
      else if (e.key === "ArrowDown") shiftInstrument(-1);
      else if (k === "l") toggleLoop();
      else if (e.key === "+" || e.key === "=") setZoom(s.project.layout.zoom + 0.1);
      else if (e.key === "-") setZoom(s.project.layout.zoom - 0.1);
      else if (hasNotes && k === "a") toggleArticulation("accent");
      else if (hasNotes && k === "g") toggleArticulation("ghost");
      else if (hasNotes && instrument) changeInstrument(instrument.id);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Writes a recovery draft shortly after each change (FR-FILE-03). */
function useAutosave() {
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (!s.dirty || s.project === prev.project) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const { project, filePath } = useEditor.getState();
        autosave(JSON.stringify(project), filePath).catch(showError);
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);
}

/** Module-level so React StrictMode's double effect run doesn't prompt twice. */
let recoveryChecked = false;

function useRecoveryPrompt() {
  useEffect(() => {
    if (!inDesktopApp || recoveryChecked) return;
    recoveryChecked = true;
    (async () => {
      const draft = await takeRecovery();
      if (!draft) return;
      const recover = await ask("Beatmark found unsaved changes from your last session. Recover them?", {
        title: "Recover draft",
        kind: "info",
        okLabel: "Recover",
        cancelLabel: "Discard",
      });
      if (recover) {
        useEditor.getState().load(parseProject(draft.projectJson), draft.filePath);
        useEditor.setState({ dirty: true });
      } else {
        await clearRecovery();
        await newProjectWorkspace();
      }
    })().catch(showError);
  }, []);
}
