import type { InstrumentId } from "../core/drumKit";
import { findEvent, timeSignatureAt } from "../core/score";
import { DURATION_LABELS, DURATION_VALUES, type DurationValue } from "../core/time";
import { useEditor } from "../store/editor";
import { addMeasures, changeDuration, changeInstrument, deleteSelection, loopSelection, toggleArticulation, toggleDot } from "./actions";

/** MuseScore-style duration keys. */
export const DURATION_KEYS: Record<string, DurationValue> = { "3": "32", "4": "16", "5": "8", "6": "q", "7": "h", "8": "w" };
const KEY_FOR: Record<DurationValue, string> = Object.fromEntries(Object.entries(DURATION_KEYS).map(([k, v]) => [v, k])) as Record<DurationValue, string>;

export function Inspector() {
  return (
    <aside className="inspector" aria-label="Properties">
      <NoteInputSection />
      <SelectionSection />
      <ScoreSection />
      <DrumKeySection />
    </aside>
  );
}

function NoteInputSection() {
  const noteInput = useEditor((s) => s.noteInput);
  const setNoteInput = useEditor((s) => s.setNoteInput);
  const d = useEditor((s) => s.inputDuration);
  return (
    <section>
      <h2>Note input</h2>
      <button className={noteInput ? "active wide" : "wide"} onClick={() => setNoteInput(!noteInput)} aria-pressed={noteInput}>
        {noteInput ? "✎ Note input on" : "✎ Note input off"} <kbd>N</kbd>
      </button>
      <p className="hint">{noteInput ? "Click a staff position to add a note." : "Click notes or measures to select them."}</p>
      <div className="durations" role="radiogroup" aria-label="Note value">
        {[...DURATION_VALUES].reverse().map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={d.value === v}
            className={d.value === v ? "active" : ""}
            onClick={() => changeDuration({ value: v, dots: d.dots })}
            title={`${DURATION_LABELS[v]} (${KEY_FOR[v]})`}
          >
            {DURATION_LABELS[v]}
            <kbd>{KEY_FOR[v]}</kbd>
          </button>
        ))}
        <button className={d.dots ? "active" : ""} aria-pressed={!!d.dots} onClick={toggleDot} title="Dotted (.)">
          Dotted <kbd>.</kbd>
        </button>
      </div>
    </section>
  );
}

function SelectionSection() {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const edit = useEditor((s) => s.edit);

  if (selection?.kind === "notes" && selection.ids.length) {
    const found = findEvent(project.score, selection.ids[0]);
    if (!found) return null;
    const e = found.event;
    return (
      <section>
        <h2>{selection.ids.length > 1 ? `${selection.ids.length} notes` : "Note"}</h2>
        {e.unresolved && (
          <div className="callout warning">
            <strong>? Needs review.</strong> Recognition wasn't sure about this note.
            <button
              onClick={() =>
                edit("Confirm note", (p) => {
                  for (const id of selection.ids) {
                    const f = findEvent(p.score, id);
                    if (f) f.event.unresolved = false;
                  }
                })
              }
            >
              Mark as correct
            </button>
          </div>
        )}
        <label>
          Instrument
          <select value={e.instrument} onChange={(ev) => changeInstrument(ev.target.value as InstrumentId)}>
            {project.instrumentMap.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.shortcut.toUpperCase()})
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Bar {found.measureIndex + project.score.firstMeasureNumber}, {DURATION_LABELS[e.duration.value].toLowerCase()}
          {e.duration.dots ? " (dotted)" : ""}. ←/→ move, ↑/↓ change drum.
        </p>
        <div className="row">
          <button className={e.articulations.includes("accent") ? "active" : ""} onClick={() => toggleArticulation("accent")}>
            Accent <kbd>A</kbd>
          </button>
          <button className={e.articulations.includes("ghost") ? "active" : ""} onClick={() => toggleArticulation("ghost")}>
            Ghost <kbd>G</kbd>
          </button>
          <button className="danger" onClick={deleteSelection}>
            Delete <kbd>⌫</kbd>
          </button>
        </div>
      </section>
    );
  }

  if (selection?.kind === "measures") {
    const { start, end } = selection;
    const n = project.score.firstMeasureNumber;
    const ts = timeSignatureAt(project.score, start);
    return (
      <section>
        <h2>{start === end ? `Measure ${start + n}` : `Measures ${start + n}–${end + n}`}</h2>
        <div className="row">
          <button onClick={loopSelection}>⟳ Loop these</button>
          <button onClick={() => addMeasures(start)}>Insert before</button>
          <button onClick={() => addMeasures(end + 1)}>Insert after</button>
        </div>
        <label>
          Time signature from here
          <TimeSigInput
            value={`${ts.beats}/${ts.beatUnit}`}
            onChange={(beats, beatUnit) =>
              edit("Change time signature", (p) => {
                if (start === 0) p.score.timeSignature = { beats, beatUnit };
                else p.score.measures[start].timeSignature = { beats, beatUnit };
              })
            }
          />
        </label>
        <button className="danger" onClick={deleteSelection}>
          Delete measure{start === end ? "" : "s"}
        </button>
      </section>
    );
  }
  return null;
}

function ScoreSection() {
  const project = useEditor((s) => s.project);
  const edit = useEditor((s) => s.edit);
  const setLayout = useEditor((s) => s.setLayout);
  const { score, metadata, layout } = project;
  return (
    <section>
      <h2>Score</h2>
      <label>
        Title
        <input
          value={metadata.title}
          onChange={(e) =>
            edit("Rename", (p) => {
              p.metadata.title = e.target.value;
            })
          }
        />
      </label>
      <div className="row">
        <label>
          Written tempo
          <input
            type="number"
            min={20}
            max={300}
            value={score.tempo}
            onChange={(e) =>
              edit("Change tempo marking", (p) => {
                p.score.tempo = Number(e.target.value) || p.score.tempo;
              })
            }
          />
        </label>
        <label>
          First bar no.
          <input
            type="number"
            min={1}
            value={score.firstMeasureNumber}
            onChange={(e) =>
              edit("Change numbering", (p) => {
                p.score.firstMeasureNumber = Math.max(1, Number(e.target.value) || 1);
              })
            }
          />
        </label>
      </div>
      <div className="row">
        <label>
          Bars per line
          <input
            type="number"
            min={1}
            max={8}
            value={layout.measuresPerSystem}
            onChange={(e) => setLayout({ measuresPerSystem: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <label>
          Bars
          <input value={score.measures.length} readOnly />
        </label>
      </div>
      <button onClick={() => addMeasures(score.measures.length, 4)}>+ Add 4 bars</button>
    </section>
  );
}

function DrumKeySection() {
  const map = useEditor((s) => s.project.instrumentMap);
  const edit = useEditor((s) => s.edit);
  return (
    <section>
      <h2>Drum key</h2>
      <p className="hint">Staff position: 0 = bottom line, 8 = top line. Change it to match your source.</p>
      <table className="drum-key">
        <tbody>
          {map.map((d, i) => (
            <tr key={d.id}>
              <td>
                <kbd>{d.shortcut.toUpperCase()}</kbd>
              </td>
              <td>{d.name}</td>
              <td>{d.notehead === "normal" ? "●" : d.notehead === "x" ? "✕" : "⊗"}</td>
              <td>
                <input
                  type="number"
                  aria-label={`${d.name} staff position`}
                  value={d.staffStep}
                  min={-4}
                  max={13}
                  onChange={(e) =>
                    edit("Remap drum", (p) => {
                      p.instrumentMap[i].staffStep = Number(e.target.value);
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TimeSigInput({ value, onChange }: { value: string; onChange: (beats: number, unit: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(...(e.target.value.split("/").map(Number) as [number, number]))}>
      {["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"].map((t) => (
        <option key={t}>{t}</option>
      ))}
      {!["2/4", "3/4", "4/4", "5/4", "6/8", "7/8", "12/8"].includes(value) && <option>{value}</option>}
    </select>
  );
}
