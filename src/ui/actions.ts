import { ask } from "@tauri-apps/plugin-dialog";
import type { Articulation, Dynamic } from "../core/project";
import { createProject, parseProject } from "../core/project";
import { findInstrument, type InstrumentId } from "../core/drumKit";
import { deleteMeasures, deleteNotes, findEvent, insertMeasures, measureStartTicks, moveNote, setDuration, setInstrument, timeSignatureAt } from "../core/score";
import { durationTicks, measureTicks, type NoteDuration } from "../core/time";
import {
  clearRecovery,
  importSources,
  inDesktopApp,
  newProjectWorkspace,
  openProject,
  pickProjectToOpen,
  pickSaveLocation,
  recognizeSource,
  saveProject,
  saveTextFile,
} from "../io/backend";
import { exportMusicXml } from "../io/musicxml";
import { assemble, type Recognition } from "../omr/assemble";
import { engine } from "../playback/engine";
import { selectedNoteIds, useEditor } from "../store/editor";
import { showError, showStatus } from "./status";

const state = () => useEditor.getState();

// ---- Files ----

async function confirmDiscard(): Promise<boolean> {
  if (!state().dirty) return true;
  const msg = "You have unsaved changes. Discard them?";
  return inDesktopApp ? ask(msg, { title: "Unsaved changes", kind: "warning" }) : window.confirm(msg);
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return;
  engine.stop();
  await newProjectWorkspace();
  state().load(createProject(), null);
}

export async function openProjectFile(): Promise<void> {
  try {
    if (!(await confirmDiscard())) return;
    const path = await pickProjectToOpen();
    if (!path) return;
    engine.stop();
    state().load(parseProject(await openProject(path)), path);
    showStatus(`Opened ${baseName(path)}`);
  } catch (e) {
    showError(e);
  }
}

export async function saveProjectFile(saveAs = false): Promise<void> {
  try {
    const { project, filePath } = state();
    const path = !saveAs && filePath ? filePath : await pickSaveLocation(project.metadata.title);
    if (!path) return;
    const stamped = { ...project, metadata: { ...project.metadata, modified: new Date().toISOString() } };
    await saveProject(path, JSON.stringify(stamped));
    state().markSaved(path);
    await clearRecovery();
    showStatus(`Saved ${baseName(path)}`);
  } catch (e) {
    showError(e);
  }
}

export async function importSourceImages(): Promise<void> {
  try {
    const sources = await importSources((text) => showStatus(text));
    if (!sources.length) return;
    state().edit("Import source", (p) => {
      p.sources.push(...sources);
    });
    showStatus(
      `Imported ${sources.length} page(s). Recognition works best on sharp, straight, uncompressed images of standard drum notation.`,
    );
  } catch (e) {
    showError(e);
  }
}

/** Set while recognition runs, so the button can't start it twice. */
let recognizing = false;

/**
 * Read every source page in order and replace the score with what was recognized.
 * One undoable edit; doubtful measures and notes come back marked for review.
 */
export async function recognizeAllSources(): Promise<void> {
  if (recognizing) return;
  const { project } = state();
  if (!project.sources.length) {
    showStatus("Import a screenshot or PDF first.", "warning");
    return;
  }
  const hasNotes = project.score.measures.some((m) => m.events.length);
  if (hasNotes) {
    const msg = "Replace the current score with the recognized notation? You can undo this.";
    const ok = inDesktopApp ? await ask(msg, { title: "Recognize notation", kind: "warning", okLabel: "Replace" }) : window.confirm(msg);
    if (!ok) return;
  }
  recognizing = true;
  try {
    engine.stop();
    const pages: { sourceId: string; recognition: Recognition }[] = [];
    for (const [i, source] of project.sources.entries()) {
      showStatus(`Reading page ${i + 1} of ${project.sources.length}…`);
      pages.push({ sourceId: source.id, recognition: await recognizeSource(source.fileName) });
    }
    const result = assemble(pages, project.instrumentMap);
    if (!result.measures.length) {
      showStatus(result.warnings.join(" ") || "No notation was recognized.", "error");
      return;
    }
    state().edit("Recognize notation", (p) => {
      p.score.measures = result.measures;
      if (result.timeSignature) p.score.timeSignature = result.timeSignature;
      p.score.firstMeasureNumber = 1;
      p.practice.loop = null;
    });
    state().select(null);
    const { staves, measures, notes, flagged } = result.stats;
    const review = flagged ? ` ${flagged} measure(s) are marked "? Review" — check them against the source.` : "";
    const notesText = result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
    showStatus(`Recognized ${measures} measures and ${notes} notes from ${staves} staves.${review}${notesText}`, flagged || result.warnings.length ? "warning" : "info");
  } catch (e) {
    showError(e);
  } finally {
    recognizing = false;
  }
}

export async function exportMusicXmlFile(): Promise<void> {
  try {
    const { project } = state();
    const { xml, warnings } = exportMusicXml(project);
    const path = await saveTextFile(`${project.metadata.title || "Untitled"}.musicxml`, "musicxml", xml);
    if (!path) return;
    if (warnings.length) showStatus(`Exported with notes: ${warnings.join(" ")}`, "warning");
    else showStatus(`Exported ${baseName(path)}`);
  } catch (e) {
    showError(e);
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ---- Transport ----

export async function togglePlay(): Promise<void> {
  if (engine.state === "playing") return engine.pause();
  const { project, selection } = state();
  // Starting from stopped with a measure selected plays from that measure.
  const from =
    engine.state === "stopped" && selection?.kind === "measures" && !project.practice.loop?.enabled
      ? measureStartTicks(project.score)[selection.start]
      : undefined;
  await engine.play(project.score, project.practice, from);
}

export function stop(): void {
  engine.stop();
}

export async function restart(): Promise<void> {
  const { project } = state();
  engine.stop();
  await engine.play(project.score, project.practice);
}

export function setBpm(bpm: number): void {
  const clamped = Math.round(Math.min(300, Math.max(20, bpm)));
  if (!Number.isFinite(clamped)) return;
  state().setPractice({ bpm: clamped });
  engine.setTempo(clamped);
}

export function loopSelection(): void {
  const { selection } = state();
  if (selection?.kind !== "measures") {
    showStatus("Select one or more measures first (click a measure, shift-click to extend).", "warning");
    return;
  }
  state().setPractice({ loop: { enabled: true, startMeasure: selection.start, endMeasure: selection.end } });
  restartIfPlaying();
}

export function toggleLoop(): void {
  const { loop } = state().project.practice;
  if (!loop) return loopSelection();
  state().setPractice({ loop: { ...loop, enabled: !loop.enabled } });
  restartIfPlaying();
}

/** Loop changes alter the playing range, so restart from the current position. */
function restartIfPlaying(): void {
  if (engine.state !== "playing") return;
  const { project } = state();
  void engine.play(project.score, project.practice, engine.position() ?? undefined);
}

// ---- Editing ----

export function deleteSelection(): void {
  const { selection } = state();
  if (selection?.kind === "notes") {
    state().edit("Delete notes", (p) => deleteNotes(p.score, new Set(selection.ids)));
    state().select(null);
  } else if (selection?.kind === "measures") {
    state().edit("Delete measures", (p) => deleteMeasures(p.score, selection.start, selection.end));
    state().select(null);
  }
}

export function changeInstrument(instrument: InstrumentId): void {
  const ids = selectedNoteIds(state().selection);
  if (!ids.length) return;
  state().edit("Change instrument", (p) => ids.forEach((id) => setInstrument(p.score, id, instrument)));
}

/** Arrow up/down: move the note to the next drum-key position above or below. */
export function shiftInstrument(direction: 1 | -1): void {
  const { selection, project } = state();
  const ids = selectedNoteIds(selection);
  if (!ids.length) return;
  const map = project.instrumentMap;
  const steps = [...new Set(map.map((d) => d.staffStep))].sort((a, b) => a - b);
  state().edit("Change instrument", (p) =>
    ids.forEach((id) => {
      const found = findEvent(p.score, id);
      if (!found) return;
      const step = findInstrument(map, found.event.instrument).staffStep;
      const next = steps[steps.indexOf(step) + direction];
      const def = map.find((d) => d.staffStep === next);
      if (def) setInstrument(p.score, id, def.id);
    }),
  );
}

export function changeDuration(duration: NoteDuration): void {
  state().setInputDuration(duration);
  const { selection, project } = state();
  const ids = selectedNoteIds(selection);
  if (ids.length) state().edit("Change duration", (p) => ids.forEach((id) => setDuration(p.score, project.instrumentMap, id, duration)));
}

export function toggleDot(): void {
  const d = state().inputDuration;
  // Dotted tuplets aren't supported, so dotting a value leaves triplet mode.
  changeDuration({ value: d.value, dots: d.dots ? 0 : 1 });
}

/** Arrow left/right: move selected notes by the current input duration, within their measure. */
export function nudge(direction: 1 | -1): void {
  const { selection, inputDuration } = state();
  const ids = selectedNoteIds(selection);
  if (!ids.length) return;
  const step = durationTicks(inputDuration) * direction;
  state().edit("Move notes", (p) =>
    ids.forEach((id) => {
      const found = findEvent(p.score, id);
      if (!found) return;
      const length = measureTicks(timeSignatureAt(p.score, found.measureIndex));
      const offset = found.event.offset + step;
      if (offset >= 0 && offset < length) moveNote(p.score, id, offset);
    }),
  );
}

const EXCLUSIVE: Record<Articulation, Articulation> = { accent: "ghost", ghost: "accent", flam: "drag", drag: "flam" };

/** Tie the selected notes to the next note of the same drum. */
export function toggleTie(): void {
  const ids = selectedNoteIds(state().selection);
  if (!ids.length) return;
  state().edit("Toggle tie", (p) =>
    ids.forEach((id) => {
      const found = findEvent(p.score, id);
      if (found) found.event.tie = !found.event.tie;
    }),
  );
}

/** Switch note input between plain and triplet values (the selected notes change too). */
export function toggleTriplet(): void {
  const d = state().inputDuration;
  changeDuration(d.tuplet ? { value: d.value, dots: d.dots } : { value: d.value, dots: 0, tuplet: 3 });
}

export function setDynamic(measureIndex: number, dynamic: Dynamic | undefined): void {
  state().edit("Change dynamic", (p) => {
    p.score.measures[measureIndex].dynamic = dynamic;
  });
}

export function toggleArticulation(a: Articulation): void {
  const ids = selectedNoteIds(state().selection);
  if (!ids.length) return;
  state().edit(`Toggle ${a}`, (p) =>
    ids.forEach((id) => {
      const found = findEvent(p.score, id);
      if (!found) return;
      const list = found.event.articulations;
      // A note can't be both accented and ghosted, or both flammed and dragged.
      const other = EXCLUSIVE[a];
      found.event.articulations = list.includes(a) ? list.filter((x) => x !== a) : [...list.filter((x) => x !== other), a];
    }),
  );
}

export function addMeasures(at: number, count = 1): void {
  state().edit("Insert measures", (p) => insertMeasures(p.score, at, count));
}

export function setZoom(zoom: number): void {
  state().setLayout({ zoom: Math.min(2.5, Math.max(0.5, Math.round(zoom * 10) / 10)) });
}
