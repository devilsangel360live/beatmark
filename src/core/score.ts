import { findInstrument, type InstrumentDef, type InstrumentId, type Limb } from "./drumKit";
import { emptyMeasure, newId, type Measure, type NoteEvent, type Score } from "./project";
import { durationTicks, largestDurationWithin, measureTicks, type NoteDuration, type TimeSignature } from "./time";

export function timeSignatureAt(score: Score, measureIndex: number): TimeSignature {
  for (let i = measureIndex; i >= 0; i--) {
    const ts = score.measures[i]?.timeSignature;
    if (ts) return ts;
  }
  return score.timeSignature;
}

/** Absolute start tick of every measure, plus the end tick of the score as the final entry. */
export function measureStartTicks(score: Score): number[] {
  const starts = [0];
  score.measures.forEach((_, i) => starts.push(starts[i] + measureTicks(timeSignatureAt(score, i))));
  return starts;
}

export function limbOf(map: InstrumentDef[], id: InstrumentId): Limb {
  return findInstrument(map, id).limb;
}

/** Notes struck together in one voice. They share an offset and a duration. */
export interface Chord {
  offset: number;
  duration: NoteDuration;
  events: NoteEvent[];
}

export function chordsForLimb(measure: Measure, map: InstrumentDef[], limb: Limb): Chord[] {
  const byOffset = new Map<number, NoteEvent[]>();
  for (const e of measure.events) {
    if (limbOf(map, e.instrument) !== limb) continue;
    const list = byOffset.get(e.offset) ?? [];
    list.push(e);
    byOffset.set(e.offset, list);
  }
  return [...byOffset.entries()]
    .sort(([a], [b]) => a - b)
    .map(([offset, events]) => ({ offset, duration: events[0].duration, events }));
}

export type MeasureIssue =
  | { kind: "overflow"; eventId: string }
  | { kind: "overlap"; eventId: string };

/** Content that cannot be engraved as-is. Underfull voices are fine — rests fill them. */
export function validateMeasure(score: Score, measureIndex: number, map: InstrumentDef[]): MeasureIssue[] {
  const measure = score.measures[measureIndex];
  const length = measureTicks(timeSignatureAt(score, measureIndex));
  const issues: MeasureIssue[] = [];
  for (const limb of ["hands", "feet"] as const) {
    const chords = chordsForLimb(measure, map, limb);
    chords.forEach((c, i) => {
      const end = c.offset + durationTicks(c.duration);
      const next = chords[i + 1];
      for (const e of c.events) {
        if (end > length) issues.push({ kind: "overflow", eventId: e.id });
        else if (next && end > next.offset) issues.push({ kind: "overlap", eventId: e.id });
      }
    });
  }
  return issues;
}

// ---- Edit commands. Each mutates a draft Score (called inside an Immer recipe). ----

export interface AddNoteArgs {
  measureIndex: number;
  offset: number;
  instrument: InstrumentId;
  duration: NoteDuration;
}

/**
 * Insert a note, keeping its voice engraveable: the new chord's duration is clipped
 * to the next chord / barline, and the previous chord is shortened if it would overlap.
 * Returns the new event's id, or null if nothing fits at that position.
 */
export function addNote(score: Score, map: InstrumentDef[], args: AddNoteArgs): string | null {
  const measure = score.measures[args.measureIndex];
  const length = measureTicks(timeSignatureAt(score, args.measureIndex));
  if (args.offset < 0 || args.offset >= length) return null;
  if (measure.events.some((e) => e.offset === args.offset && e.instrument === args.instrument)) return null;

  const limb = limbOf(map, args.instrument);
  const chords = chordsForLimb(measure, map, limb);
  const existing = chords.find((c) => c.offset === args.offset);
  let duration = existing?.duration ?? args.duration;

  if (!existing) {
    const next = chords.find((c) => c.offset > args.offset);
    const room = (next?.offset ?? length) - args.offset;
    if (durationTicks(duration) > room) {
      const fit = largestDurationWithin(room);
      if (!fit) return null;
      duration = fit;
    }
    const prev = [...chords].reverse().find((c) => c.offset < args.offset);
    if (prev && prev.offset + durationTicks(prev.duration) > args.offset) {
      const fit = largestDurationWithin(args.offset - prev.offset);
      if (fit) prev.events.forEach((e) => (e.duration = fit));
    }
  }

  const id = newId();
  measure.events.push({ id, offset: args.offset, duration, instrument: args.instrument, articulations: [] });
  return id;
}

export function deleteNotes(score: Score, ids: Set<string>): void {
  for (const m of score.measures) m.events = m.events.filter((e) => !ids.has(e.id));
}

export function findEvent(score: Score, id: string): { measureIndex: number; event: NoteEvent } | null {
  for (let i = 0; i < score.measures.length; i++) {
    const event = score.measures[i].events.find((e) => e.id === id);
    if (event) return { measureIndex: i, event };
  }
  return null;
}

export function setInstrument(score: Score, id: string, instrument: InstrumentId): void {
  const found = findEvent(score, id);
  if (!found) return;
  found.event.instrument = instrument;
  found.event.unresolved = false;
}

/** Sets the duration of the whole chord the note belongs to, since a chord shares one stem. */
export function setDuration(score: Score, map: InstrumentDef[], id: string, duration: NoteDuration): void {
  const found = findEvent(score, id);
  if (!found) return;
  const limb = limbOf(map, found.event.instrument);
  for (const e of score.measures[found.measureIndex].events) {
    if (e.offset === found.event.offset && limbOf(map, e.instrument) === limb) {
      e.duration = duration;
      e.unresolved = false;
    }
  }
}

/** Move a note in time within its measure. */
export function moveNote(score: Score, id: string, offset: number): void {
  const found = findEvent(score, id);
  if (!found) return;
  const length = measureTicks(timeSignatureAt(score, found.measureIndex));
  if (offset < 0 || offset >= length) return;
  found.event.offset = offset;
}

export function insertMeasures(score: Score, atIndex: number, count = 1): void {
  score.measures.splice(atIndex, 0, ...Array.from({ length: count }, emptyMeasure));
}

export function deleteMeasures(score: Score, start: number, end: number): void {
  score.measures.splice(start, end - start + 1);
  if (score.measures.length === 0) score.measures.push(emptyMeasure());
}
