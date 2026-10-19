import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { engine } from "../playback/engine";
import { buildTimeline, locateTick } from "../playback/timeline";
import { useEditor } from "../store/editor";
import { loopSelection, restart, setBpm, stop, toggleLoop, togglePlay } from "./actions";

export function Transport() {
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const practice = useEditor((s) => s.project.practice);
  const score = useEditor((s) => s.project.score);
  const setPractice = useEditor((s) => s.setPractice);
  const [bpmText, setBpmText] = useState(String(practice.bpm));
  useEffect(() => setBpmText(String(practice.bpm)), [practice.bpm]);

  const loop = practice.loop;
  const first = score.firstMeasureNumber;

  return (
    <footer className="transport" aria-label="Transport">
      <div className="group">
        <button className="primary" onClick={() => void togglePlay()} title="Play / Pause (Space)" aria-label={state === "playing" ? "Pause" : "Play"}>
          {state === "playing" ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={stop} title="Stop (Esc)" disabled={state === "stopped"}>
          ■ Stop
        </button>
        <button onClick={() => void restart()} title="Restart from the beginning (Home)">
          ⏮ Restart
        </button>
        <Position score={score} running={state !== "stopped"} />
      </div>

      <div className="group">
        <label className="toggle">
          <input type="checkbox" checked={practice.countIn} onChange={(e) => setPractice({ countIn: e.target.checked })} />
          Count-in
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={practice.metronome}
            onChange={(e) => {
              setPractice({ metronome: e.target.checked });
              engine.setMetronome(e.target.checked);
            }}
          />
          Metronome
        </label>
      </div>

      <div className="group tempo">
        <label htmlFor="bpm">Tempo</label>
        <input
          type="range"
          min={20}
          max={300}
          value={practice.bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          aria-label="Tempo slider"
        />
        <input
          id="bpm"
          className="bpm"
          type="number"
          min={20}
          max={300}
          value={bpmText}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={() => setBpm(Number(bpmText))}
          onKeyDown={(e) => e.key === "Enter" && setBpm(Number(bpmText))}
        />
        <span className="unit">BPM</span>
        {practice.bpm !== score.tempo && (
          <button className="link" onClick={() => setBpm(score.tempo)} title="Reset to the written tempo">
            written: {score.tempo}
          </button>
        )}
      </div>

      <div className="group">
        <button onClick={loopSelection} title="Loop the selected measures">
          ⟳ Loop selection
        </button>
        <label className="toggle">
          <input type="checkbox" checked={!!loop?.enabled} onChange={toggleLoop} disabled={!loop} />
          Loop{" "}
          {!loop
            ? "(none)"
            : loop.startMeasure === loop.endMeasure
              ? `m. ${loop.startMeasure + first}`
              : `m. ${loop.startMeasure + first}–${loop.endMeasure + first}`}
        </label>
      </div>
    </footer>
  );
}

/** "Bar 3 · Beat 2" while playing. Polled, since the playhead moves continuously. */
function Position({ score, running }: { score: ReturnType<typeof useEditor.getState>["project"]["score"]; running: boolean }) {
  const timeline = useMemo(() => buildTimeline(score), [score]);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!running) return setText("");
    const id = window.setInterval(() => {
      const tick = engine.position();
      if (tick === null) return setText("Count-in…");
      const { measureIndex, offset } = locateTick(timeline, tick);
      const beat = Math.floor(offset / timeline.measureBeats[measureIndex].beatTicks) + 1;
      setText(`Bar ${measureIndex + score.firstMeasureNumber} · Beat ${beat}`);
    }, 50);
    return () => window.clearInterval(id);
  }, [running, timeline, score.firstMeasureNumber]);
  return <span className="position" aria-live="off">{text}</span>;
}
