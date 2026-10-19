import { useEffect, useState } from "react";
import { inDesktopApp, recognizeSource, sourceUrl } from "../io/backend";
import { useEditor } from "../store/editor";
import { importSourceImages } from "./actions";
import { showError } from "./status";

export function SourcePanel({ onCollapse }: { onCollapse: () => void }) {
  const sources = useEditor((s) => s.project.sources);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = sources.find((s) => s.id === activeId) ?? sources[0];
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    if (active && inDesktopApp) sourceUrl(active.fileName).then(setUrl, showError);
  }, [active?.fileName]);

  async function recognize() {
    if (!active) return;
    try {
      await recognizeSource(active.fileName);
    } catch (e) {
      showError(e);
    }
  }

  return (
    <aside className="source-panel" aria-label="Source">
      <header>
        <h2>Source</h2>
        <button className="icon" onClick={onCollapse} title="Hide source panel" aria-label="Hide source panel">
          ⟨
        </button>
      </header>
      {sources.length === 0 ? (
        <div className="empty">
          <p>Import a screenshot or scanned page to transcribe it next to the score.</p>
          <button onClick={importSourceImages}>Import image…</button>
          <p className="hint">PNG, JPEG or TIFF. Sharp, straight, uncompressed images of standard drum notation work best.</p>
        </div>
      ) : (
        <>
          {sources.length > 1 && (
            <select value={active?.id} onChange={(e) => setActiveId(e.target.value)} aria-label="Source page">
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.originalName}
                </option>
              ))}
            </select>
          )}
          <div className="source-image">{url ? <img src={url} alt={`Source: ${active?.originalName}`} /> : <p>Loading…</p>}</div>
          <div className="row">
            <button onClick={recognize}>Recognize notation</button>
            <button onClick={importSourceImages}>Add image…</button>
          </div>
        </>
      )}
    </aside>
  );
}
