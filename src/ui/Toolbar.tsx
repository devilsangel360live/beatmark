import { useEditor } from "../store/editor";
import { exportMusicXmlFile, importSourceImages, newProject, openProjectFile, saveProjectFile, setZoom } from "./actions";

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

export function Toolbar() {
  const title = useEditor((s) => s.project.metadata.title);
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const zoom = useEditor((s) => s.project.layout.zoom);
  const { undo, redo } = useEditor.getState();

  return (
    <header className="toolbar">
      <div className="group">
        <button onClick={newProject} title={`New (${MOD}N)`}>New</button>
        <button onClick={openProjectFile} title={`Open (${MOD}O)`}>Open…</button>
        <button onClick={() => saveProjectFile()} title={`Save (${MOD}S)`}>Save</button>
        <button onClick={importSourceImages}>Import image…</button>
      </div>
      <div className="group">
        <button onClick={undo} disabled={!canUndo} title={`Undo (${MOD}Z)`} aria-label="Undo">↶</button>
        <button onClick={redo} disabled={!canRedo} title={`Redo (${MOD}⇧Z)`} aria-label="Redo">↷</button>
      </div>
      <div className="title" title={dirty ? "Unsaved changes" : "Saved"}>
        {title || "Untitled"}
        {dirty && <span className="dirty"> — edited</span>}
      </div>
      <div className="group">
        <button onClick={() => setZoom(zoom - 0.1)} aria-label="Zoom out" title="Zoom out (−)">−</button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(zoom + 0.1)} aria-label="Zoom in" title="Zoom in (+)">+</button>
      </div>
      <div className="group">
        <button onClick={exportMusicXmlFile}>Export MusicXML…</button>
      </div>
    </header>
  );
}
