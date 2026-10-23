import { DRUMEO_KEY, type InstrumentDef, type InstrumentId } from "./drumKit";
import { PPQ, type NoteDuration, type TimeSignature } from "./time";

export const SCHEMA_VERSION = 1;

/** "flam" = one grace note before the hit; "drag" = two. */
export type Articulation = "accent" | "ghost" | "flam" | "drag";

export type Dynamic = "pp" | "p" | "mp" | "mf" | "f" | "ff";
export const DYNAMICS: Dynamic[] = ["pp", "p", "mp", "mf", "f", "ff"];

export interface NoteEvent {
  id: string;
  /** Ticks from the start of the measure. */
  offset: number;
  duration: NoteDuration;
  instrument: InstrumentId;
  articulations: Articulation[];
  /** 0–1, set by recognition. Absent for notes the user entered. */
  confidence?: number;
  /** Recognition could not decide instrument or duration; the user must confirm. */
  unresolved?: boolean;
  /** Tied to the next note of the same instrument, which then sustains instead of being struck. */
  tie?: boolean;
}

export interface Measure {
  id: string;
  /** Overrides the score time signature from this measure onward. */
  timeSignature?: TimeSignature;
  events: NoteEvent[];
  /** Dynamic marking shown under the start of the measure. */
  dynamic?: Dynamic;
  /** Lowest confidence among this measure's recognized content. */
  confidence?: number;
  /** Where a recognized measure came from, for showing it next to the score. */
  source?: { sourceId: string; box: [number, number, number, number] };
}

export interface Score {
  timeSignature: TimeSignature;
  /** Written tempo (quarter-note BPM). Playback tempo lives in `practice`. */
  tempo: number;
  measures: Measure[];
  /** Number shown on the first measure, for excerpts that start mid-song. */
  firstMeasureNumber: number;
}

export interface Layout {
  measuresPerSystem: number;
  zoom: number;
}

export interface Practice {
  bpm: number;
  countIn: boolean;
  metronome: boolean;
  loop: { enabled: boolean; startMeasure: number; endMeasure: number } | null;
}

export interface SourceRef {
  id: string;
  /** File name inside the project package's `sources/` folder. */
  fileName: string;
  originalName: string;
  page?: number;
  crop?: { x: number; y: number; width: number; height: number };
  rotation?: number;
}

export interface Project {
  schemaVersion: number;
  metadata: { title: string; attribution: string; created: string; modified: string };
  score: Score;
  instrumentMap: InstrumentDef[];
  layout: Layout;
  practice: Practice;
  sources: SourceRef[];
}

export function newId(): string {
  return crypto.randomUUID();
}

export function emptyMeasure(): Measure {
  return { id: newId(), events: [] };
}

export function createProject(title = "Untitled"): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { title, attribution: "", created: now, modified: now },
    score: {
      timeSignature: { beats: 4, beatUnit: 4 },
      tempo: 100,
      measures: [emptyMeasure(), emptyMeasure(), emptyMeasure(), emptyMeasure()],
      firstMeasureNumber: 1,
    },
    instrumentMap: structuredClone(DRUMEO_KEY),
    layout: { measuresPerSystem: 4, zoom: 1.3 },
    practice: { bpm: 100, countIn: true, metronome: false, loop: null },
    sources: [],
  };
}

/** A basic rock beat so a new project has something to play. */
export function createDemoProject(): Project {
  const p = createProject("Rock beat");
  const eighth: NoteDuration = { value: "8", dots: 0 };
  const note = (offset: number, instrument: InstrumentId): NoteEvent => ({
    id: newId(),
    offset,
    duration: eighth,
    instrument,
    articulations: [],
  });
  p.score.measures = Array.from({ length: 4 }, (_, m) => {
    const events: NoteEvent[] = [];
    for (let i = 0; i < 8; i++) {
      const offset = (i * PPQ) / 2;
      events.push(note(offset, m === 3 && i === 7 ? "hihat-open" : "hihat-closed"));
    }
    events.push(note(PPQ, "snare"), note(PPQ * 3, "snare"));
    events.push(note(0, "kick"), note(PPQ * 2, "kick"), note(PPQ * 2.5, "kick"));
    return { id: newId(), events };
  });
  return p;
}

export function parseProject(json: string): Project {
  const p = JSON.parse(json) as Project;
  if (p.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported project version ${p.schemaVersion} (this app reads version ${SCHEMA_VERSION}).`);
  }
  return p;
}
