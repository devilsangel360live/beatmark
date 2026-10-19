import { describe, expect, it } from "vitest";
import { DRUMEO_KEY } from "./drumKit";
import { createDemoProject, createProject } from "./project";
import { addNote, measureStartTicks, setDuration, validateMeasure } from "./score";
import { PPQ, restsForGap } from "./time";

const q = { value: "q", dots: 0 } as const;
const eighth = { value: "8", dots: 0 } as const;

describe("addNote", () => {
  it("clips a new note to the next chord in the same voice", () => {
    const { score } = createProject();
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: PPQ, instrument: "snare", duration: q });
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: PPQ / 2, instrument: "snare", duration: q });
    const added = score.measures[0].events.find((e) => e.offset === PPQ / 2)!;
    expect(added.duration).toEqual(eighth);
    expect(validateMeasure(score, 0, DRUMEO_KEY)).toEqual([]);
  });

  it("shortens the previous chord instead of overlapping it", () => {
    const { score } = createProject();
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: 0, instrument: "snare", duration: q });
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: PPQ / 2, instrument: "tom-high", duration: eighth });
    expect(score.measures[0].events[0].duration).toEqual(eighth);
    expect(validateMeasure(score, 0, DRUMEO_KEY)).toEqual([]);
  });

  it("joins an existing chord and takes its duration", () => {
    const { score } = createProject();
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: 0, instrument: "hihat-closed", duration: eighth });
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: 0, instrument: "snare", duration: q });
    expect(score.measures[0].events.map((e) => e.duration)).toEqual([eighth, eighth]);
  });

  it("keeps feet and hands in independent voices", () => {
    const { score } = createProject();
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: 0, instrument: "kick", duration: q });
    addNote(score, DRUMEO_KEY, { measureIndex: 0, offset: 0, instrument: "snare", duration: eighth });
    expect(score.measures[0].events.map((e) => e.duration)).toEqual([q, eighth]);
  });
});

describe("setDuration", () => {
  it("applies to the whole chord", () => {
    const { score } = createDemoProject();
    const hat = score.measures[0].events.find((e) => e.offset === PPQ && e.instrument === "hihat-closed")!;
    setDuration(score, DRUMEO_KEY, hat.id, q);
    const atBeat2 = score.measures[0].events.filter((e) => e.offset === PPQ);
    expect(atBeat2.every((e) => e.duration.value === "q")).toBe(true);
  });
});

describe("validateMeasure", () => {
  it("flags overlapping notes in one voice", () => {
    const { score } = createProject();
    score.measures[0].events.push(
      { id: "a", offset: 0, duration: q, instrument: "snare", articulations: [] },
      { id: "b", offset: PPQ / 2, duration: eighth, instrument: "snare", articulations: [] },
    );
    expect(validateMeasure(score, 0, DRUMEO_KEY)).toEqual([{ kind: "overlap", eventId: "a" }]);
  });
});

describe("timing helpers", () => {
  it("computes measure starts across a time signature change", () => {
    const { score } = createProject();
    score.measures[2].timeSignature = { beats: 3, beatUnit: 4 };
    expect(measureStartTicks(score)).toEqual([0, 1920, 3840, 5280, 6720]);
  });

  it("splits rests at beat boundaries", () => {
    const ts = { beats: 4, beatUnit: 4 };
    expect(restsForGap(PPQ / 2, PPQ * 3, ts).map((r) => [r.offset, r.duration.value])).toEqual([
      [240, "8"],
      [480, "h"],
    ]);
    expect(restsForGap(0, PPQ * 4, ts).map((r) => r.duration.value)).toEqual(["w"]);
  });
});
