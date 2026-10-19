import type { InstrumentId } from "../../src/core/drumKit";
import { createProject, newId, type Measure, type NoteEvent, type Project } from "../../src/core/project";
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
}

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
  };

  const p = createProject("synth");
  p.score.timeSignature = ts;
  p.score.tempo = rng.int(50, 200);
  p.score.firstMeasureNumber = rng.chance(0.5) ? 1 : rng.int(2, 80);
  const length = measureTicks(ts);
  const maxMeasures = length > PPQ * 4 ? 2 : 4;
  p.score.measures = Array.from({ length: rng.int(1, maxMeasures) }, (_, i) => measure(rng, ts, style, i));
  p.layout.measuresPerSystem = p.score.measures.length;
  return p;
}

function measure(rng: Rng, ts: TimeSignature, style: Style, index: number): Measure {
  const length = measureTicks(ts);
  const events: NoteEvent[] = [];
  const add = (offset: number, duration: NoteDuration, instrument: InstrumentId, accent = false) =>
    events.push({ id: newId(), offset, duration, instrument, articulations: accent ? ["accent"] : [] });

  // ---- Hands: an ostinato with backbeats, or a fill. ----
  if (rng.chance(style.fillChance)) {
    const onsets = randomRhythm(rng, length, rng.pick([PPQ / 4, PPQ / 2]));
    onsets.forEach(({ offset, duration }, i) => {
      const drum = rng.pick<InstrumentId>(["snare", "snare", "tom-high", "tom-mid", "tom-floor"]);
      add(offset, duration, drum, rng.chance(style.accentChance));
      if (i === 0 && rng.chance(0.3)) add(offset, duration, "crash");
    });
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
    for (let t = 0; t < length; t += style.kickGrid) {
      if ((t === 0 && rng.chance(0.9)) || rng.chance(style.kickDensity)) hits.set(t, ["kick"]);
    }
    if (style.pedalHat) for (const b of backbeatOffsets(ts)) hits.set(b, [...(hits.get(b) ?? []), "hihat-pedal"]);
    const offsets = [...hits.keys()].sort((a, b) => a - b);
    offsets.forEach((offset, i) => {
      const gap = (offsets[i + 1] ?? length) - offset;
      const duration =
        rng.chance(0.5) ? (largestDurationWithin(gap) ?? { value: "16", dots: 0 }) : (largestDurationWithin(Math.min(gap, style.kickGrid)) ?? { value: "16", dots: 0 });
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
