import { describe, expect, it } from "vitest";
import { buildTimeline, GRACE_LEAD_TICKS } from "../playback/timeline";
import { createProject, type NoteEvent } from "./project";
import { tieTargets, tupletGroups } from "./score";
import { durationTicks, PPQ, tupletGroupTicks, type NoteDuration } from "./time";

const ev = (id: string, offset: number, duration: NoteDuration, extra: Partial<NoteEvent> = {}): NoteEvent => ({
  id,
  offset,
  duration,
  instrument: "snare",
  articulations: [],
  ...extra,
});

const triplet8 = { value: "8", dots: 0, tuplet: 3 } as const;
const sextuplet16 = { value: "16", dots: 0, tuplet: 6 } as const;

describe("tuplets", () => {
  it("play at two thirds of the written value", () => {
    expect(durationTicks(triplet8)).toBe(160);
    expect(tupletGroupTicks(triplet8)).toBe(PPQ);
    expect(durationTicks(sextuplet16)).toBe(80);
    expect(tupletGroupTicks(sextuplet16)).toBe(PPQ);
  });

  it("groups only complete, aligned runs", () => {
    const chord = {};
    const items = [
      { offset: 0, duration: triplet8, chord },
      { offset: 160, duration: triplet8, chord },
      { offset: 320, duration: triplet8, chord },
      // An incomplete group: two triplet eighths and nothing else.
      { offset: 480, duration: triplet8, chord },
      { offset: 640, duration: triplet8, chord },
    ];
    expect(tupletGroups(items)).toEqual([{ first: 0, last: 2, tuplet: 3, notesOccupied: 2 }]);
  });
});

describe("ties", () => {
  it("connect to the next note of the same instrument, across barlines", () => {
    const { score } = createProject();
    const q = { value: "q", dots: 0 } as const;
    score.measures[0].events.push(ev("a", PPQ * 3, q, { instrument: "crash", tie: true }), ev("x", PPQ * 3, q));
    score.measures[1].events.push(ev("b", 0, q, { instrument: "crash" }), ev("y", 0, q));
    expect([...tieTargets(score)]).toEqual([["a", "b"]]);

    // Playback strikes the crash once; the snare twice.
    const crashes = buildTimeline(score).hits.filter((h) => h.instrument === "crash");
    expect(crashes.map((h) => h.tick)).toEqual([PPQ * 3]);
  });
});

describe("flams and drags", () => {
  it("add quiet grace hits just before the main hit", () => {
    const { score } = createProject();
    const q = { value: "q", dots: 0 } as const;
    score.measures[0].events.push(ev("f", PPQ, q, { articulations: ["flam"] }), ev("d", PPQ * 2, q, { articulations: ["drag"] }));
    const hits = buildTimeline(score).hits.map((h) => [h.tick, h.articulations.join()]);
    expect(hits).toEqual([
      [PPQ - GRACE_LEAD_TICKS, "ghost"],
      [PPQ, "flam"],
      [PPQ * 2 - 2 * GRACE_LEAD_TICKS, "ghost"],
      [PPQ * 2 - GRACE_LEAD_TICKS, "ghost"],
      [PPQ * 2, "drag"],
    ]);
  });
});
