import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { InstrumentDef } from "../core/drumKit";
import { addNote, measureStartTicks } from "../core/score";
import { durationTicks } from "../core/time";
import { engine } from "../playback/engine";
import { engrave, offsetForX, staffStepForY, xForOffset, type MeasureGeom, type ScoreLayout } from "../render/engrave";
import { selectedNoteIds, useEditor } from "../store/editor";

const LOW_CONFIDENCE = 0.6;

export function ScoreView() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const noteInput = useEditor((s) => s.noteInput);
  const loop = project.practice.loop;

  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);
  const [layout, setLayout] = useState<ScoreLayout | null>(null);

  useEffect(() => {
    // VexFlow's music font is bundled but loads asynchronously; engraving before it's ready mis-measures glyphs.
    document.fonts.load("30px Bravura").finally(() => setFontsReady(true));
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!fontsReady || !width || !hostRef.current) return;
    setLayout(engrave(hostRef.current, project, { width, selected: new Set(selectedNoteIds(selection)) }));
  }, [project.score, project.instrumentMap, project.layout, selection, width, fontsReady]);

  // Keep a playing score in sync with edits.
  useEffect(() => engine.updateScore(project.score), [project.score]);

  const starts = useMemo(() => measureStartTicks(project.score), [project.score]);

  // The cursor follows the audio clock every frame, outside React rendering.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = cursorRef.current;
      const tick = engine.state === "stopped" ? null : engine.position();
      if (!el || !layout || tick === null) {
        if (el) el.style.display = "none";
        return;
      }
      let i = 0;
      while (i < starts.length - 2 && starts[i + 1] <= tick) i++;
      const m = layout.measures[i];
      if (!m) return;
      const sp = m.lineSpacing;
      el.style.display = "block";
      el.style.transform = `translate(${xForOffset(m, tick - starts[i]) - 4}px, ${m.top - sp * 2}px)`;
      el.style.height = `${m.bottom - m.top + sp * 4}px`;
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [layout, starts]);

  function onMouseDown(ev: MouseEvent<HTMLDivElement>) {
    if (!layout || !hostRef.current) return;
    const rect = hostRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const store = useEditor.getState();

    const radius = (layout.measures[0]?.lineSpacing ?? 10) * 0.7;
    const hit = layout.notes.find((n) => Math.hypot(n.x - x, n.y - y) <= radius);
    if (hit) {
      const ids = selectedNoteIds(store.selection);
      store.select({ kind: "notes", ids: ev.shiftKey ? [...new Set([...ids, hit.eventId])] : [hit.eventId] });
      return;
    }

    const m = measureAt(layout.measures, x, y);
    if (!m) {
      store.select(null);
      return;
    }

    if (store.noteInput) {
      const def = nearestInstrument(store.project.instrumentMap, staffStepForY(m, y));
      if (!def) return;
      const grid = durationTicks(store.inputDuration);
      const offset = Math.min(Math.round(offsetForX(m, x) / grid) * grid, m.ticks - grid);
      const id = store.edit("Add note", (p) =>
        addNote(p.score, p.instrumentMap, { measureIndex: m.index, offset: Math.max(0, offset), instrument: def.id, duration: store.inputDuration }),
      );
      if (id) store.select({ kind: "notes", ids: [id] });
      return;
    }

    const sel = store.selection;
    if (ev.shiftKey && sel?.kind === "measures") {
      store.select({ kind: "measures", start: Math.min(sel.start, m.index), end: Math.max(sel.end, m.index) });
    } else {
      store.select({ kind: "measures", start: m.index, end: m.index });
    }
  }

  const measureBox = (m: MeasureGeom) => {
    const sp = m.lineSpacing;
    // Tall enough to cover cymbal beams above the staff and kick stems below it.
    return { left: m.x, top: m.top - sp * 4.5, width: m.width, height: m.bottom - m.top + sp * 8 };
  };

  return (
    <div className={`score-wrap${noteInput ? " note-input" : ""}`} ref={wrapRef}>
      <div className="score-canvas" style={{ height: layout?.height }} onMouseDown={onMouseDown}>
        <div ref={hostRef} className="score-svg" />
        {layout?.measures.map((m) => {
          const inLoop = loop?.enabled && m.index >= loop.startMeasure && m.index <= loop.endMeasure;
          const selected = selection?.kind === "measures" && m.index >= selection.start && m.index <= selection.end;
          const lowConfidence = m.confidence !== undefined && m.confidence < LOW_CONFIDENCE;
          const box = measureBox(m);
          return (
            <div key={m.index}>
              {inLoop && (
                <div className="overlay loop" style={box}>
                  {loop!.startMeasure === loop!.endMeasure ? (
                    <span className="loop-label">⟳ Loop</span>
                  ) : (
                    <>
                      {m.index === loop!.startMeasure && <span className="loop-label">⟳ Loop start</span>}
                      {m.index === loop!.endMeasure && <span className="loop-label end">Loop end</span>}
                    </>
                  )}
                </div>
              )}
              {selected && <div className="overlay selected-measure" style={box} />}
              {(lowConfidence || m.issues.length > 0) && (
                <div
                  className={`overlay review${m.issues.length ? " invalid" : ""}`}
                  style={box}
                  title={m.issues.length ? "Notes overlap or overflow this measure" : "Low recognition confidence — check against the source"}
                >
                  <span className="review-badge">{m.issues.length ? "! Check rhythm" : "? Review"}</span>
                </div>
              )}
            </div>
          );
        })}
        <div ref={cursorRef} className="playhead" />
      </div>
    </div>
  );
}

function measureAt(measures: MeasureGeom[], x: number, y: number): MeasureGeom | undefined {
  return measures.find((m) => {
    const pad = m.lineSpacing * 4;
    return x >= m.x && x < m.x + m.width && y >= m.top - pad && y <= m.bottom + pad;
  });
}

/** The drum-key instrument at this staff position, or one step away if nothing is mapped there. */
function nearestInstrument(map: InstrumentDef[], step: number): InstrumentDef | undefined {
  return map.find((d) => d.staffStep === step) ?? map.find((d) => Math.abs(d.staffStep - step) === 1);
}
