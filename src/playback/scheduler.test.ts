import { describe, expect, it } from "vitest";
import { createDemoProject } from "../core/project";
import { PPQ } from "../core/time";
import { Scheduler, START_DELAY, type ScheduledSound } from "./scheduler";
import { buildTimeline } from "./timeline";

const project = createDemoProject();
const timeline = buildTimeline(project.score);
const MEASURE = PPQ * 4;

/** Drive the scheduler like the engine does: pump every 25 ms with 100 ms lookahead. */
function run(s: Scheduler, until: number, onTick?: (now: number) => void): ScheduledSound[] {
  const out: ScheduledSound[] = [];
  for (let now = 0; now < until; now += 0.025) {
    onTick?.(now);
    out.push(...s.pump(now, 0.1));
  }
  return out;
}

const kicks = (sounds: ScheduledSound[]) =>
  sounds.filter((s) => s.kind === "hit" && s.instrument === "kick").map((s) => +s.time.toFixed(6));

describe("Scheduler", () => {
  it("places hits at exact tempo-derived times", () => {
    // 120 BPM: one quarter = 0.5 s. Demo measure 1 kicks on beats 1, 3 and the "and" of 3.
    const s = new Scheduler(timeline, { bpm: 120, start: 0, end: MEASURE, loop: false, countIn: false, metronome: false }, 0);
    expect(kicks(run(s, 3))).toEqual([0, 1, 1.25].map((t) => +(t + START_DELAY).toFixed(6)));
    expect(s.endTime).toBeCloseTo(2 + START_DELAY);
  });

  it("loops seamlessly with no gap at the wrap", () => {
    const s = new Scheduler(timeline, { bpm: 120, start: 0, end: MEASURE, loop: true, countIn: false, metronome: false }, 0);
    const times = kicks(run(s, 4.5));
    expect(times.slice(0, 6)).toEqual([0, 1, 1.25, 2, 3, 3.25].map((t) => +(t + START_DELAY).toFixed(6)));
    expect(s.endTime).toBeNull();
  });

  it("delays the score by one measure of count-in clicks", () => {
    const s = new Scheduler(timeline, { bpm: 120, start: 0, end: MEASURE, loop: false, countIn: true, metronome: false }, 0);
    const sounds = run(s, 4);
    const clicks = sounds.filter((x) => x.kind === "click");
    expect(clicks).toHaveLength(4);
    expect(kicks(sounds)[0]).toBeCloseTo(2 + START_DELAY);
    expect(s.tickAt(1)).toBeNull();
  });

  it("re-times future hits after a tempo change without moving the playhead", () => {
    const s = new Scheduler(timeline, { bpm: 120, start: 0, end: MEASURE, loop: false, countIn: false, metronome: false }, 0);
    let sounds: ScheduledSound[] = [];
    for (let i = 0; i < 120; i++) {
      const now = i * 0.025;
      if (i === 22) {
        // 0.55 s = tick 480 (beat 2). Cancel what the engine had queued past this point.
        const tickBefore = s.tickAt(now)!;
        const cancelAfter = s.setTempo(now, 60);
        expect(s.tickAt(now)).toBeCloseTo(tickBefore);
        sounds = sounds.filter((x) => x.time <= cancelAfter);
      }
      sounds.push(...s.pump(now, 0.1));
    }
    // Beat 3 kick is at tick 960: 480 ticks after the change, which takes 1 s at 60 BPM.
    const k = kicks(sounds);
    expect(k).toHaveLength(3);
    [START_DELAY, 1.55, 2.05].forEach((t, i) => expect(k[i]).toBeCloseTo(t, 2));
    // The hi-hat exactly at the change point (tick 480, 0.55 s) plays once, not twice.
    const hatsAtChange = sounds.filter((x) => x.kind === "hit" && x.instrument === "hihat-closed" && Math.abs(x.time - 0.55) < 0.01);
    expect(hatsAtChange).toHaveLength(1);
  });

  it("maps audio time back to score ticks for the cursor", () => {
    const s = new Scheduler(timeline, { bpm: 120, start: MEASURE, end: MEASURE * 2, loop: true, countIn: false, metronome: false }, 0);
    run(s, 0.5);
    expect(s.tickAt(START_DELAY + 0.5)).toBeCloseTo(MEASURE + PPQ);
    run(s, 3);
    // Second time round the loop, same place in the measure.
    expect(s.tickAt(START_DELAY + 2.5)).toBeCloseTo(MEASURE + PPQ);
  });
});
