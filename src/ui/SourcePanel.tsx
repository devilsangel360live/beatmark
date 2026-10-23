import { useEffect, useRef, useState } from "react";
import { inDesktopApp, sourceUrl } from "../io/backend";
import { useEditor } from "../store/editor";
import { importSourceImages, recognizeAllSources } from "./actions";
import { showError } from "./status";

export function SourcePanel({ onCollapse }: { onCollapse: () => void }) {
  const sources = useEditor((s) => s.project.sources);
  const selection = useEditor((s) => s.selection);
  const measures = useEditor((s) => s.project.score.measures);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // A selected recognized measure shows the page it came from, with its region highlighted (FR-OCR-04).
  const linked = selection?.kind === "measures" ? measures[selection.start]?.source : undefined;
  const active = sources.find((s) => s.id === (linked?.sourceId ?? chosenId)) ?? sources[0];

  useEffect(() => {
    setUrl(null);
    setNatural(null);
    if (active && inDesktopApp) sourceUrl(active.fileName).then(setUrl, showError);
  }, [active?.fileName]);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [linked?.box.join(), natural]);

  async function recognize() {
    setBusy(true);
    try {
      await recognizeAllSources();
    } finally {
      setBusy(false);
    }
  }

  const box = linked && natural && linked.sourceId === active?.id ? linked.box : null;

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
          <p>Import a screenshot or PDF of drum notation to turn it into an editable score.</p>
          <button onClick={importSourceImages}>Import image or PDF…</button>
          <p className="hint">Sharp, straight, uncompressed images of standard five-line drum notation work best. Each PDF page becomes a source page.</p>
        </div>
      ) : (
        <>
          <div className="row">
            <button className="primary" onClick={recognize} disabled={busy} aria-busy={busy}>
              {busy ? "Reading…" : "Recognize notation"}
            </button>
            <button onClick={importSourceImages} disabled={busy}>
              Add…
            </button>
          </div>
          {sources.length > 1 && (
            <select value={active?.id} onChange={(e) => setChosenId(e.target.value)} aria-label="Source page">
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.originalName}
                </option>
              ))}
            </select>
          )}
          <p className="hint">
            {linked ? "Highlighted: where the selected measure was read from." : "Select a recognized measure to see where it came from."}
          </p>
          <div className="source-image">
            {url ? (
              <div className="source-frame">
                <img src={url} alt={`Source: ${active?.originalName}`} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                {box && natural && (
                  <div
                    ref={highlightRef}
                    className="source-highlight"
                    style={{
                      left: `${(box[0] / natural.w) * 100}%`,
                      top: `${(box[1] / natural.h) * 100}%`,
                      width: `${((box[2] - box[0]) / natural.w) * 100}%`,
                      height: `${((box[3] - box[1]) / natural.h) * 100}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <p>Loading…</p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
