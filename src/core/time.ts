/** Ticks per quarter note. All musical positions are integer ticks, never seconds. */
export const PPQ = 480;

export type DurationValue = "w" | "h" | "q" | "8" | "16" | "32";

export interface NoteDuration {
  value: DurationValue;
  dots: 0 | 1;
}

export interface TimeSignature {
  beats: number;
  beatUnit: number;
}

export const DURATION_VALUES: DurationValue[] = ["w", "h", "q", "8", "16", "32"];

const BASE_TICKS: Record<DurationValue, number> = {
  w: PPQ * 4,
  h: PPQ * 2,
  q: PPQ,
  "8": PPQ / 2,
  "16": PPQ / 4,
  "32": PPQ / 8,
};

export const DURATION_LABELS: Record<DurationValue, string> = {
  w: "Whole",
  h: "Half",
  q: "Quarter",
  "8": "Eighth",
  "16": "16th",
  "32": "32nd",
};

export function durationTicks(d: NoteDuration): number {
  const base = BASE_TICKS[d.value];
  return d.dots ? base + base / 2 : base;
}

export function measureTicks(ts: TimeSignature): number {
  return (ts.beats * PPQ * 4) / ts.beatUnit;
}

export function beatTicks(ts: TimeSignature): number {
  return (PPQ * 4) / ts.beatUnit;
}

/** Every representable duration, longest first. */
const ALL_DURATIONS: NoteDuration[] = DURATION_VALUES.flatMap((value) => [
  { value, dots: 1 as const },
  { value, dots: 0 as const },
]).sort((a, b) => durationTicks(b) - durationTicks(a));

/** Longest single duration that fits in `ticks`, or null if none does. */
export function largestDurationWithin(ticks: number): NoteDuration | null {
  return ALL_DURATIONS.find((d) => durationTicks(d) <= ticks) ?? null;
}

/**
 * Split a gap into rest durations. Gaps are first cut at beat boundaries so
 * rests read the way a drummer expects (no dotted-quarter rest across beat 2).
 */
export function restsForGap(start: number, end: number, ts: TimeSignature): { offset: number; duration: NoteDuration }[] {
  const beat = beatTicks(ts);
  const out: { offset: number; duration: NoteDuration }[] = [];
  let pos = start;
  // A rest covering an entire empty measure is one whole-measure rest.
  if (start === 0 && end === measureTicks(ts)) {
    const whole = largestDurationWithin(end);
    if (whole && durationTicks(whole) === end) return [{ offset: 0, duration: whole }];
  }
  while (pos < end) {
    const nextBeat = Math.min(end, (Math.floor(pos / beat) + 1) * beat);
    const limit = pos % beat === 0 ? end : nextBeat;
    const span = limit - pos;
    const d = largestUndottedWithin(span) ?? largestDurationWithin(span);
    if (!d) break; // gap finer than a 32nd — not representable, leave it
    out.push({ offset: pos, duration: d });
    pos += durationTicks(d);
  }
  return out;
}

function largestUndottedWithin(ticks: number): NoteDuration | null {
  const v = DURATION_VALUES.find((value) => BASE_TICKS[value] <= ticks);
  return v ? { value: v, dots: 0 } : null;
}
