import { findInstrument, type InstrumentId } from "../../src/core/drumKit";
import { createProject, DYNAMICS, newId, type Articulation, type Measure, type NoteEvent, type Project } from "../../src/core/project";
import { durationTicks, largestDurationWithin, measureTicks, PPQ, type NoteDuration, type TimeSignature } from "../../src/core/time";

/** Small seeded PRNG (mulberry32) so every sample can be regenerated from its seed. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)],
    weighted: <T>(items: [T, number][]) => {
      let r = next() * items.reduce((s, [, w]) => s + w, 0);
      for (const [item, w] of items) if ((r -= w) <= 0) return item;
      return items[items.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

interface Style {
  cymbal: InstrumentId;
  /** Ostinato subdivision in ticks (quarter, eighth or 16th). */
  unit: number;
  kickGrid: number;
  kickDensity: number;
  pedalHat: boolean;
  fillChance: number;
  restChance: number;
  accentChance: number;
  /** Chance that a snare or tom hit gets a flam or drag. */
  graceChance: number;
  /** Chance that a fill is played in triplets or sextuplets. */
  tupletFillChance: number;
  /** Triplet-feel groove: the ostinato is in triplet eighths. */
  shuffle: boolean;
}

const DRUMS: InstrumentId[] = ["snare", "snare", "tom-high", "tom-mid", "tom-floor"];

// 4/4 dominates real drum charts, but every digit needs enough examples to be learned
// (a first run with 4/4 at 70% never learned 2, 3, 5, 6 or 7).
const TIME_SIGNATURES: [TimeSignature, number][] = [
  [{ beats: 4, beatUnit: 4 }, 40],
  [{ beats: 3, beatUnit: 4 }, 12],
  [{ beats: 2, beatUnit: 4 }, 8],
  [{ beats: 6, beatUnit: 8 }, 12],
  [{ beats: 12, beatUnit: 8 }, 8],
  [{ beats: 5, beatUnit: 4 }, 7],
  [{ beats: 7, beatUnit: 8 }, 7],
  [{ beats: 9, beatUnit: 8 }, 6],
];

/** A random one-system drum excerpt (1–4 measures) in a randomly chosen style. */
export function randomGroove(seed: number): Project {
  const rng = makeRng(seed);
  const ts = rng.weighted(TIME_SIGNATURES);
  const compound = ts.beatUnit === 8;
  const style: Style = {
    cymbal: rng.weighted<InstrumentId>([["hihat-closed", 70], ["ride", 22], ["crash", 3], ["tom-floor", 5]]),
    unit: compound ? PPQ / 2 : rng.weighted([[PPQ / 2, 55], [PPQ / 4, 30], [PPQ, 15]]),
    kickGrid: rng.weighted([[PPQ / 2, 60], [PPQ / 4, 40]]),
    kickDensity: rng.next() * 0.45,
    pedalHat: rng.chance(0.15),
    fillChance: rng.next() * 0.3,
    restChance: rng.next() * 0.15,
    accentChance: rng.chance(0.3) ? rng.next() * 0.3 : 0,
    graceChance: rng.chance(0.35) ? 0.1 + rng.next() * 0.3 : 0,
    tupletFillChance: compound ? 0 : rng.next() * 0.6,
    shuffle: !compound && rng.chance(0.1),
  };

  const p = createProject("synth");
  p.score.timeSignature = ts;
  p.score.tempo = rng.int(50, 200);
  p.score.firstMeasureNumber = rng.chance(0.5) ? 1 : rng.int(2, 80);
  const length = measureTicks(ts);
  const maxMeasures = length > PPQ * 4 ? 2 : 4;
  // Fills are more common now that they carry the tuplets and grace notes.
  if (style.tupletFillChance || style.graceChance) style.fillChance = Math.max(style.fillChance, 0.25);
  p.score.measures = Array.from({ length: rng.int(1, maxMeasures) }, (_, i) => measure(rng, ts, style, i));
  p.layout.measuresPerSystem = p.score.measures.length;

  if (rng.chance(0.3)) p.score.measures[0].dynamic = rng.pick(DYNAMICS);
  if (p.score.measures.length > 1 && rng.chance(0.15)) p.score.measures[rng.int(1, p.score.measures.length - 1)].dynamic = rng.pick(DYNAMICS);
  if (p.score.measures.length > 1 && rng.chance(0.2)) addCrashTie(p.score.measures, rng.int(0, p.score.measures.length - 2), p.instrumentMap);
  return p;
}

/**
 * A crash on the last hand chord of a measure, tied into a crash on the next downbeat:
 * the usual reason a drum part has a tie.
 */
function addCrashTie(measures: Measure[], i: number, map: Project["instrumentMap"]): void {
  const hands = (m: Measure) => m.events.filter((e) => findInstrument(map, e.instrument).limb === "hands");
  const last = hands(measures[i]).sort((a, b) => b.offset - a.offset)[0];
  const next = hands(measures[i + 1]).find((e) => e.offset === 0);
  if (!last || !next) return;
  const crash = (m: Measure, like: NoteEvent) => {
    const existing = m.events.find((e) => e.offset === like.offset && e.instrument === "crash");
    if (existing) return existing;
    const e: NoteEvent = { id: newId(), offset: like.offset, duration: like.duration, instrument: "crash", articulations: [] };
    m.events.push(e);
    return e;
  };
  crash(measures[i], last).tie = true;
  crash(measures[i + 1], next);
}

/**
 * Sometimes the excerpt includes a multi-bar rest (e.g. "8" over a thick bar). Returns where to
 * insert how many empty bars; the Verovio path compresses them into one multi-bar rest.
 */
export function randomRestRun(seed: number, measureCount: number): { at: number; count: number } | null {
  const rng = makeRng(seed ^ 0x7e57);
  if (!rng.chance(0.25)) return null;
  return { at: rng.int(0, measureCount), count: rng.weighted([[2, 20], [4, 25], [8, 25], [rng.int(3, 16), 30]]) };
}

function measure(rng: Rng, ts: TimeSignature, style: Style, index: number): Measure {
  const length = measureTicks(ts);
  const events: NoteEvent[] = [];
  const add = (offset: number, duration: NoteDuration, instrument: InstrumentId, accent = false) => {
    const articulations: Articulation[] = accent ? ["accent"] : [];
    // Flams and drags go on drums, not cymbals.
    if (DRUMS.includes(instrument) && rng.chance(style.graceChance)) articulations.push(rng.chance(0.7) ? "flam" : "drag");
    events.push({ id: newId(), offset, duration, instrument, articulations });
  };

  // ---- Hands: an ostinato with backbeats, a fill, or a triplet fill. ----
  if (rng.chance(style.fillChance) && rng.chance(style.tupletFillChance)) {
    // Each beat is a full group of triplet eighths or 16th sextuplets.
    for (let beat = 0; beat < length; beat += PPQ) {
      const d: NoteDuration = rng.chance(0.6) ? { value: "8", dots: 0, tuplet: 3 } : { value: "16", dots: 0, tuplet: 6 };
      const step = durationTicks(d);
      for (let k = 0; k < d.tuplet!; k++) add(beat + k * step, d, rng.pick(DRUMS), k === 0 && rng.chance(style.accentChance * 2));
    }
  } else if (rng.chance(style.fillChance)) {
    const onsets = randomRhythm(rng, length, rng.pick([PPQ / 4, PPQ / 2]));
    onsets.forEach(({ offset, duration }, i) => {
      add(offset, duration, rng.pick(DRUMS), rng.chance(style.accentChance));
      if (i === 0 && rng.chance(0.3)) add(offset, duration, "crash");
    });
  } else if (style.shuffle) {
    // Triplet feel: every triplet eighth on the cymbal, snare on the backbeats. No rests,
    // so every group is complete and drawn with its "3".
    const d: NoteDuration = { value: "8", dots: 0, tuplet: 3 };
    const backbeats = backbeatOffsets(ts);
    for (let t = 0; t < length; t += durationTicks(d)) {
      add(t, d, style.cymbal, rng.chance(style.accentChance));
      if (backbeats.includes(t)) add(t, d, "snare");
    }
  } else {
    const backbeats = backbeatOffsets(ts);
    const onsets: number[] = [];
    for (let t = 0; t < length; t += style.unit) if (!rng.chance(style.restChance)) onsets.push(t);
    onsets.forEach((offset, i) => {
      const gap = (onsets[i + 1] ?? length) - offset;
      const duration = rng.chance(0.6) ? (largestDurationWithin(Math.min(gap, style.unit)) ?? { value: "16", dots: 0 }) : (largestDurationWithin(gap) ?? { value: "16", dots: 0 });
      const accent = rng.chance(style.accentChance);
      let cymbal = style.cymbal;
      if (offset === 0 && index === 0 && rng.chance(0.25)) cymbal = "crash";
      else if (cymbal === "hihat-closed" && rng.chance(0.06)) cymbal = "hihat-open";
      if (rng.chance(0.95)) add(offset, duration, cymbal, accent);
      if (backbeats.includes(offset) || rng.chance(0.05)) add(offset, duration, "snare", accent && rng.chance(0.5));
    });
  }

  // ---- Feet: kick on the downbeat plus random grid hits; optional hi-hat pedal. ----
  if (!rng.chance(0.1)) {
    const hits = new Map<number, InstrumentId[]>();
    // Under a shuffle the feet stay on the beat.
    const grid = style.shuffle ? PPQ : style.kickGrid;
    for (let t = 0; t < length; t += grid) {
      if ((t === 0 && rng.chance(0.9)) || rng.chance(style.kickDensity)) hits.set(t, ["kick"]);
    }
    if (style.pedalHat) for (const b of backbeatOffsets(ts)) hits.set(b, [...(hits.get(b) ?? []), "hihat-pedal"]);
    const offsets = [...hits.keys()].sort((a, b) => a - b);
    offsets.forEach((offset, i) => {
      const gap = (offsets[i + 1] ?? length) - offset;
      const duration =
        rng.chance(0.5) ? (largestDurationWithin(gap) ?? { value: "16", dots: 0 }) : (largestDurationWithin(Math.min(gap, grid)) ?? { value: "16", dots: 0 });
      for (const drum of hits.get(offset)!) add(offset, duration, drum);
    });
  }
  return { id: newId(), events };
}

/** Beats where the snare usually lands: 2 and 4 in 4/4, 3 in 3/4, 4 in 6/8, etc. */
function backbeatOffsets(ts: TimeSignature): number[] {
  const beat = (PPQ * 4) / ts.beatUnit;
  if (ts.beatUnit === 8) {
    const groups = ts.beats === 7 ? [0, 2, 4] : Array.from({ length: ts.beats / 3 }, (_, g) => g * 3);
    return groups.filter((_, i) => i % 2 === 1).map((g) => g * beat);
  }
  if (ts.beats === 3) return [2 * beat];
  return Array.from({ length: ts.beats }, (_, b) => b).filter((b) => b % 2 === 1).map((b) => b * beat);
}

/** Random onsets covering the measure, built from units of `smallest` ticks, including dotted values. */
function randomRhythm(rng: Rng, length: number, smallest: number): { offset: number; duration: NoteDuration }[] {
  const out: { offset: number; duration: NoteDuration }[] = [];
  let pos = 0;
  while (pos < length) {
    const choices = [smallest, smallest * 2, smallest * 3, smallest * 4].filter((t) => pos + t <= length);
    const span = rng.pick(choices.length ? choices : [length - pos]);
    const d = largestDurationWithin(span) ?? { value: "32", dots: 0 };
    if (!rng.chance(0.1)) out.push({ offset: pos, duration: d });
    pos += durationTicks(d);
  }
  return out;
}
