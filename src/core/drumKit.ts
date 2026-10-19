export type InstrumentId =
  | "kick"
  | "snare"
  | "hihat-closed"
  | "hihat-open"
  | "hihat-pedal"
  | "tom-high"
  | "tom-mid"
  | "tom-floor"
  | "crash"
  | "ride";

export type Notehead = "normal" | "x" | "circle-x";

/** Hands are written stems-up, feet stems-down. */
export type Limb = "hands" | "feet";

export interface InstrumentDef {
  id: InstrumentId;
  name: string;
  /** Staff position: 0 = bottom line, 1 = bottom space, ... 8 = top line. Negative = below. */
  staffStep: number;
  notehead: Notehead;
  limb: Limb;
  /** General MIDI percussion note, used for MusicXML and future MIDI export. */
  midi: number;
  /** Single-key shortcut for changing the selected note's instrument. */
  shortcut: string;
}

/**
 * Default drum key, following Drumeo's "How To Read Drum Music" conventions.
 * Stored per project so the user can remap it to match a different source.
 */
export const DRUMEO_KEY: InstrumentDef[] = [
  { id: "crash", name: "Crash", staffStep: 10, notehead: "x", limb: "hands", midi: 49, shortcut: "c" },
  { id: "hihat-closed", name: "Hi-hat (closed)", staffStep: 9, notehead: "x", limb: "hands", midi: 42, shortcut: "h" },
  { id: "hihat-open", name: "Hi-hat (open)", staffStep: 9, notehead: "circle-x", limb: "hands", midi: 46, shortcut: "o" },
  { id: "ride", name: "Ride", staffStep: 8, notehead: "x", limb: "hands", midi: 51, shortcut: "r" },
  { id: "tom-high", name: "High tom", staffStep: 7, notehead: "normal", limb: "hands", midi: 50, shortcut: "t" },
  { id: "tom-mid", name: "Mid tom", staffStep: 6, notehead: "normal", limb: "hands", midi: 47, shortcut: "m" },
  { id: "snare", name: "Snare", staffStep: 5, notehead: "normal", limb: "hands", midi: 38, shortcut: "s" },
  { id: "tom-floor", name: "Floor tom", staffStep: 3, notehead: "normal", limb: "hands", midi: 43, shortcut: "f" },
  { id: "kick", name: "Bass drum", staffStep: 1, notehead: "normal", limb: "feet", midi: 36, shortcut: "k" },
  { id: "hihat-pedal", name: "Hi-hat (foot)", staffStep: -1, notehead: "x", limb: "feet", midi: 44, shortcut: "p" },
];

const LETTERS = ["c", "d", "e", "f", "g", "a", "b"] as const;
/** Diatonic index of E4 (the bottom staff line in treble-equivalent positions). */
const BOTTOM_LINE_INDEX = 4 * 7 + 2;

/** Treble-equivalent display pitch for a staff step, e.g. 5 → { step: "C", octave: 5 }. */
export function staffStepToPitch(staffStep: number): { step: string; octave: number } {
  const n = BOTTOM_LINE_INDEX + staffStep;
  return { step: LETTERS[((n % 7) + 7) % 7].toUpperCase(), octave: Math.floor(n / 7) };
}

export function findInstrument(map: InstrumentDef[], id: InstrumentId): InstrumentDef {
  const def = map.find((i) => i.id === id);
  if (!def) throw new Error(`Instrument ${id} missing from drum key`);
  return def;
}

/** First instrument written at this staff position, if any. */
export function instrumentAtStep(map: InstrumentDef[], staffStep: number): InstrumentDef | undefined {
  return map.find((i) => i.staffStep === staffStep);
}
