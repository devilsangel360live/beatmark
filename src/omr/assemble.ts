/**
 * The music half of recognition: turns the symbols the detector found on each staff
 * (src-tauri/src/omr) into measures of timed notes in Beatmark's score model.
 *
 * Rules, all in staff-crop pixels where staff lines are 16 px apart:
 *  - Drum:     notehead height on the staff → staff step → the project's drum key.
 *  - Chord:    noteheads stacked at the same x share a stem.
 *  - Voices:   hands are stems-up. If a bar has beams or flags below the staff, the feet are a
 *              separate stems-down voice; otherwise (e.g. Drumeo) the kick shares the up-stems.
 *  - Rhythm:   beams or flag on the stem side (1 = eighth, 2 = 16th, 3 = 32nd), otherwise the
 *              notehead (whole, half, quarter); dots; tuplet "3"/"6" numbers.
 *  - Ornament: grace noteheads just before a chord make it a flam (one) or drag (two or more).
 *  - Check:    each voice must fill its bar exactly; a bar that doesn't is flagged for review.
 * Nothing here guesses silently: uncertain notes are marked unresolved (FR-OCR-06).
 */
import { findInstrument, type InstrumentDef, type Notehead } from "../core/drumKit";
import { emptyMeasure, newId, type Articulation, type Measure, type NoteEvent } from "../core/project";
import { durationTicks, largestDurationWithin, measureTicks, type DurationValue, type NoteDuration, type TimeSignature } from "../core/time";

// ---- What the Rust side returns (src-tauri/src/omr/mod.rs). ----

export interface Detection {
  class: string;
  score: number;
  /** x0, y0, x1, y1 in the staff crop. */
  bbox: [number, number, number, number];
}

export interface RecognizedStaff {
  pageBox: [number, number, number, number];
  cropWidth: number;
  cropHeight: number;
  topLine: number;
  bottomLine: number;
  barlines: number[];
  symbols: Detection[];
}

export interface Recognition {
  staves: RecognizedStaff[];
  deskew: number;
  warnings: string[];
}

export interface AssembleResult {
  measures: Measure[];
  /** Time signature of the first recognized measure, if one was printed. */
  timeSignature?: TimeSignature;
  warnings: string[];
  stats: { staves: number; measures: number; notes: number; flagged: number };
}

/** Detections at or above this are trusted; 0.3–0.5 ones become notes marked for review. */
const ACCEPT = 0.5;
/** Measures below this confidence show the "? Review" marker in the score. */
const REVIEW_CONFIDENCE = 0.55;

const HEAD_NOTEHEAD: Record<string, Notehead> = {
  head_black: "normal",
  head_half: "normal",
  head_whole: "normal",
  head_x: "x",
  head_circle_x: "circle-x",
};
const REST_VALUE: Record<string, DurationValue> = {
  rest_whole: "w",
  rest_half: "h",
  rest_quarter: "q",
  rest_8th: "8",
  rest_16th: "16",
  rest_32nd: "32",
};
const FLAG_LEVEL: Record<string, number> = { flag_8th: 1, flag_16th: 2, flag_32nd: 3 };
const LEVEL_VALUE: DurationValue[] = ["q", "8", "16", "32"];

interface Box {
  cls: string;
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
}

interface Head extends Box {
  step: number;
  instrument?: InstrumentDef;
  unresolved: boolean;
}

interface Chord {
  heads: Head[];
  x: number;
  /** Stem position: right edge for stems up, left edge for stems down. */
  stemX: number;
  up: boolean;
  duration: NoteDuration;
  articulations: Set<Articulation>;
}

type VoiceItem = { kind: "chord"; chord: Chord; x: number } | { kind: "rest"; duration: NoteDuration; x: number; whole: boolean };

const toBox = (d: Detection): Box => {
  const [x0, y0, x1, y1] = d.bbox;
  return { cls: d.class, score: d.score, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};

/** Turn one or more recognized pages into measures for the given drum key. */
export function assemble(pages: { sourceId: string; recognition: Recognition }[], map: InstrumentDef[]): AssembleResult {
  const measures: Measure[] = [];
  const warnings = new Set<string>();
  let timeSignature: TimeSignature | undefined;
  let current: TimeSignature = { beats: 4, beatUnit: 4 };
  let staves = 0;

  for (const { sourceId, recognition } of pages) {
    recognition.warnings.forEach((w) => warnings.add(w));
    for (const staff of recognition.staves) {
      staves++;
      const result = assembleStaff(staff, map, current, sourceId, warnings);
      if (result.timeSignature) {
        // A time signature at the start of the piece sets the score's; later ones are changes.
        if (!timeSignature && measures.length === 0) timeSignature = result.timeSignature;
        else if (result.measures[0] && !sameTs(result.timeSignature, current)) result.measures[0].timeSignature = result.timeSignature;
        current = result.timeSignature;
      }
      measures.push(...result.measures);
    }
  }
  const notes = measures.reduce((n, m) => n + m.events.length, 0);
  const flagged = measures.filter((m) => (m.confidence ?? 1) < REVIEW_CONFIDENCE).length;
  if (!measures.length) warnings.add("No measures could be read from this source.");
  return { measures, timeSignature, warnings: [...warnings], stats: { staves, measures: measures.length, notes, flagged } };
}

const sameTs = (a: TimeSignature, b: TimeSignature) => a.beats === b.beats && a.beatUnit === b.beatUnit;

function assembleStaff(
  staff: RecognizedStaff,
  map: InstrumentDef[],
  ts: TimeSignature,
  sourceId: string,
  warnings: Set<string>,
): { measures: Measure[]; timeSignature?: TimeSignature } {
  const sp = (staff.bottomLine - staff.topLine) / 4;
  const mid = staff.topLine + 2 * sp;
  const stepOf = (y: number) => Math.round((staff.bottomLine - y) / (sp / 2));
  const boxes = staff.symbols.map(toBox);
  const sure = boxes.filter((b) => b.score >= ACCEPT);

  // Time signature: digits inside the staff before the first note.
  const firstNoteX = Math.min(...sure.filter((b) => b.cls.startsWith("head_") || b.cls.startsWith("rest_")).map((b) => b.x0), Infinity);
  const tsDigits = digitsOnly(sure.filter((b) => b.cls.startsWith("timesig_") && b.cx < firstNoteX && b.cy > staff.topLine - sp && b.cy < staff.bottomLine + sp));
  const readNumber = (digits: Box[]) => Number(digits.sort((a, b) => a.x0 - b.x0).map((d) => d.cls.slice(-1)).join(""));
  const upper = tsDigits.filter((d) => d.cy < mid);
  const lower = tsDigits.filter((d) => d.cy >= mid);
  let staffTs: TimeSignature | undefined;
  if (upper.length && lower.length) {
    const candidate = { beats: readNumber(upper), beatUnit: readNumber(lower) };
    if (candidate.beats > 0 && [2, 4, 8, 16].includes(candidate.beatUnit)) staffTs = candidate;
  }
  const activeTs = staffTs ?? ts;

  // Measure boundaries: barlines, plus the staff's ends.
  const edges = [0, ...staff.barlines, staff.cropWidth];
  const measures: Measure[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const [left, right] = [edges[k], edges[k + 1]];
    const inBar = (b: Box) => b.cx > left && b.cx < right;
    const content = boxes.filter(inBar);
    const musical = content.filter((b) => b.cls.startsWith("head_") || b.cls.startsWith("rest_"));

    const scale = (staff.pageBox[2] - staff.pageBox[0]) / staff.cropWidth;
    const source = {
      sourceId,
      box: [staff.pageBox[0] + left * scale, staff.pageBox[1], staff.pageBox[0] + right * scale, staff.pageBox[3]] as [number, number, number, number],
    };

    // A multi-bar rest stands for N empty measures; N is printed above the staff. A thick bar
    // with a number is distinctive, so a weak detection still counts (and is marked for review),
    // and a bar holding nothing but a number above the staff is one too.
    const multirest = content.find((b) => b.cls === "multirest" && b.score >= 0.3);
    const countDigits = digitsOnly(content.filter((b) => b.cls.startsWith("timesig_") && b.cy < staff.topLine && b.score >= 0.3));
    const nothingElse = !content.some((b) => b.score >= ACCEPT && (b.cls.startsWith("head_") || b.cls.startsWith("rest_")));
    if (multirest || (countDigits.length && nothingElse)) {
      const count = countDigits.length ? readNumber(countDigits) : 0;
      if (!count) warnings.add("A multi-bar rest's bar count couldn't be read; it was entered as one bar. Check the number of bars.");
      const confidence = Math.min(multirest?.score ?? 0.5, ...countDigits.map((d) => d.score));
      for (let i = 0; i < Math.max(1, count); i++) {
        measures.push({ ...emptyMeasure(), confidence: count ? confidence : 0.3, source });
      }
      continue;
    }
    if (!musical.length) continue;

    const measure = buildMeasure(content, sp, mid, staff, stepOf, map, activeTs);
    measures.push({ ...measure, source });
  }
  if (confident(boxes, "dynamic").length) {
    warnings.add("Dynamic markings were spotted but can't be read yet; add them from the measure panel if you need them.");
  }
  if (confident(boxes, "head_slash").length) {
    warnings.add("Slash noteheads (rhythm slashes) were found; they aren't converted to notes.");
  }
  return { measures, timeSignature: staffTs };
}

const confident = (boxes: Box[], cls: string) => boxes.filter((b) => b.cls === cls && b.score >= ACCEPT);

/**
 * Distinct beam levels at a stem. A secondary beam is often detected as separate pieces
 * between each pair of stems, so a stem in the middle of a group touches two pieces of the
 * same level; pieces at the same height count once.
 */
function beamLevels(beams: Box[]): number {
  const levels: Box[] = [];
  for (const b of [...beams].sort((a, c) => a.cy - c.cy)) {
    const same = levels.some((l) => Math.min(l.y1, b.y1) - Math.max(l.y0, b.y0) > 0.5 * Math.min(l.y1 - l.y0, b.y1 - b.y0));
    if (!same) levels.push(b);
  }
  return levels.length;
}

/** One digit per printed position: where the detector proposed two digits for one glyph, keep the likelier. */
function digitsOnly(digits: Box[]): Box[] {
  const kept: Box[] = [];
  for (const d of [...digits].sort((a, b) => b.score - a.score)) {
    // Overlap in both directions: the two digits of a time signature share x but not y.
    const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * Math.min(a1 - a0, b1 - b0);
    const overlaps = kept.some((k) => overlap(k.x0, k.x1, d.x0, d.x1) && overlap(k.y0, k.y1, d.y0, d.y1));
    if (!overlaps) kept.push(d);
  }
  return kept;
}

function buildMeasure(
  boxes: Box[],
  sp: number,
  mid: number,
  staff: RecognizedStaff,
  stepOf: (y: number) => number,
  map: InstrumentDef[],
  ts: TimeSignature,
): Measure {
  const length = measureTicks(ts);
  const sure = boxes.filter((b) => b.score >= ACCEPT);
  const of = (prefix: string) => sure.filter((b) => b.cls.startsWith(prefix));

  // Noteheads, including doubtful ones (marked for review).
  const heads: Head[] = boxes
    .filter((b) => b.cls in HEAD_NOTEHEAD && b.score >= 0.3)
    .map((b) => {
      const step = stepOf(b.cy);
      const kind = HEAD_NOTEHEAD[b.cls];
      const exact = map.find((d) => d.staffStep === step && d.notehead === kind);
      const near = exact ?? map.find((d) => Math.abs(d.staffStep - step) === 1 && d.notehead === kind);
      return { ...b, step, instrument: near, unresolved: !exact || b.score < ACCEPT };
    });

  // Two notated voices only if something hangs below the staff: beams or flags of stems-down feet.
  const below = (b: Box) => b.cy > staff.bottomLine + sp * 0.5;
  const twoVoices = [...of("beam"), ...of("flag_")].some(below);
  const isFeet = (h: Head) => twoVoices && h.instrument?.limb === "feet";

  const chords = (feet: boolean) => groupChords(heads.filter((h) => isFeet(h) === feet), sp, !feet);
  const voices = twoVoices ? [chords(false), chords(true)] : [chords(false)];

  const beams = of("beam");
  const flags = of("flag_");
  const dots = of("dot");
  for (const chord of voices.flat()) {
    // Beams and flags on the stem side, within stem reach. A kick on the bottom space that shares
    // a stem with the cymbals reaches beams about 8 spaces up, so allow 10.
    const reach = 10 * sp;
    const top = Math.min(...chord.heads.map((h) => h.y0));
    const bottom = Math.max(...chord.heads.map((h) => h.y1));
    const side = (b: Box) => (chord.up ? b.cy < top && b.cy > bottom - reach : b.cy > bottom && b.cy < top + reach);
    const covering = beams.filter((b) => side(b) && b.x0 - 3 <= chord.stemX && chord.stemX <= b.x1 + 3);
    const flag = flags.find((f) => side(f) && f.x0 >= chord.stemX - 0.6 * sp && f.x0 <= chord.stemX + 1.2 * sp);
    const level = Math.min(3, beamLevels(covering) || (flag ? FLAG_LEVEL[flag.cls] : 0));
    const head = chord.heads[0];
    const value: DurationValue = level ? LEVEL_VALUE[level] : head.cls === "head_whole" ? "w" : head.cls === "head_half" ? "h" : "q";
    const right = Math.max(...chord.heads.map((h) => h.x1));
    const dotted = dots.some((d) => d.x0 > right - 1 && d.x0 - right < 1.4 * sp && chord.heads.some((h) => Math.abs(d.cy - h.cy) < 0.7 * sp));
    chord.duration = { value, dots: dotted ? 1 : 0 };
  }

  // Tuplets: each "3"/"6" applies to the n chords of its voice nearest to it.
  for (const t of of("tuplet_")) {
    const n = t.cls === "tuplet_3" ? 3 : 6;
    const voice = twoVoices && below(t) ? voices[1] : voices[0];
    const nearest = [...voice].sort((a, b) => Math.abs(a.x - t.cx) - Math.abs(b.x - t.cx)).slice(0, n);
    for (const c of nearest) c.duration = { value: c.duration.value, dots: 0, tuplet: n };
  }

  // Grace notes: the chord just to their right gets a flam (one) or drag (two or more).
  const graces = of("grace_head");
  for (const voice of voices) {
    for (const c of voice) {
      const before = graces.filter((g) => g.x1 <= Math.min(...c.heads.map((h) => h.x0)) + 2 && Math.min(...c.heads.map((h) => h.x0)) - g.x1 < 3.5 * sp);
      const claimed = before.filter((g) => voice.every((o) => o === c || !(o.x < c.x && o.x > g.cx)));
      if (claimed.length) c.articulations.add(claimed.length > 1 ? "drag" : "flam");
    }
  }
  // Accents above (or below, for a stems-down voice) a chord.
  for (const a of of("accent")) {
    const voice = twoVoices && below(a) ? voices[1] : voices[0];
    const target = voice.find((c) => Math.abs(c.x - a.cx) < 1.2 * sp);
    target?.articulations.add("accent");
  }

  // Rests, assigned to a voice by height when there are two.
  const rests: VoiceItem[][] = voices.map(() => []);
  for (const r of of("rest_")) {
    const v = twoVoices && r.cy > mid + 0.5 * sp ? 1 : 0;
    rests[v].push({ kind: "rest", duration: { value: REST_VALUE[r.cls], dots: dots.some((d) => d.x0 > r.x1 - 1 && d.x0 - r.x1 < sp && Math.abs(d.cy - r.cy) < sp) ? 1 : 0 }, x: r.cx, whole: r.cls === "rest_whole" });
  }

  // Time: walk each voice left to right, adding durations.
  const events: NoteEvent[] = [];
  const eventOf = new Map<Head, NoteEvent>();
  /** Where printed rests begin in the first voice; re-notation never stretches a note over one. */
  const restStarts: number[] = [];
  let fits = true;
  voices.forEach((voice, v) => {
    const items: VoiceItem[] = [...voice.map((c) => ({ kind: "chord" as const, chord: c, x: c.x })), ...rests[v]].sort((a, b) => a.x - b.x);
    let offset = 0;
    for (const item of items) {
      if (item.kind === "rest") {
        if (v === 0) restStarts.push(offset);
        // A whole rest means "this voice is silent for the whole bar", whatever the meter.
        offset += item.whole ? length : durationTicks(item.duration);
        continue;
      }
      const { chord } = item;
      for (const h of chord.heads) {
        if (!h.instrument) continue;
        const articulations = [...chord.articulations].filter((a) => a !== "accent" || h.instrument!.limb === "hands");
        const event: NoteEvent = {
          id: newId(),
          offset: Math.min(offset, length - 1),
          duration: chord.duration,
          instrument: h.instrument.id,
          articulations,
          confidence: h.score,
          unresolved: h.unresolved || offset >= length,
        };
        events.push(event);
        eventOf.set(h, event);
      }
      offset += durationTicks(chord.duration);
    }
    if (items.length && offset !== length) fits = false;
  });

  // Beatmark writes hands stems-up and feet stems-down. When the source shared one stem between
  // them (as Drumeo does), keeping the short shared values would fill both voices with rests.
  // Same timing, cleaner page: each note lasts until the next note on the same limb.
  if (!twoVoices && fits) {
    for (const limb of ["hands", "feet"] as const) {
      const own = events.filter((e) => findInstrument(map, e.instrument).limb === limb);
      const onsets = [...new Set(own.map((e) => e.offset))].sort((a, b) => a - b);
      for (const e of own) {
        if (e.duration.tuplet) continue;
        const next = Math.min(onsets.find((o) => o > e.offset) ?? length, restStarts.find((r) => r > e.offset) ?? length);
        const longer = largestDurationWithin(next - e.offset);
        if (longer && durationTicks(longer) > durationTicks(e.duration)) e.duration = longer;
      }
    }
  }

  // Ties: an arc starting just right of a notehead ties that note to the next one on its drum.
  for (const t of of("tie")) {
    const start = heads
      .filter((h) => h.instrument && h.x1 <= t.x0 + sp && t.x0 - h.x1 < 2 * sp && Math.abs(h.cy - t.cy) < 2 * sp)
      .sort((a, b) => b.x1 - a.x1)[0];
    const event = start && eventOf.get(start);
    if (event) event.tie = true;
  }

  const scores = [...heads.map((h) => h.score), ...of("rest_").map((r) => r.score)];
  let confidence = scores.length ? Math.min(...scores) : 1;
  if (!fits || heads.some((h) => !h.instrument)) confidence = Math.min(confidence, 0.4);
  if (heads.some((h) => !h.instrument)) {
    // Keep the unplaceable head visible as an unresolved note on the nearest drum.
    for (const h of heads.filter((x) => !x.instrument)) {
      const nearest = [...map].sort((a, b) => Math.abs(a.staffStep - h.step) - Math.abs(b.staffStep - h.step))[0];
      events.push({ id: newId(), offset: 0, duration: { value: "q", dots: 0 }, instrument: nearest.id, articulations: [], confidence: h.score, unresolved: true });
    }
  }
  return { id: newId(), events, confidence };
}

/** Noteheads within ~0.8 staff spaces of each other horizontally share a stem. */
function groupChords(heads: Head[], sp: number, up: boolean): Chord[] {
  const sorted = [...heads].sort((a, b) => a.cx - b.cx);
  const chords: Chord[] = [];
  for (const h of sorted) {
    const last = chords[chords.length - 1];
    if (last && h.cx - last.x < 0.8 * sp) {
      last.heads.push(h);
      last.x = last.heads.reduce((s, x) => s + x.cx, 0) / last.heads.length;
    } else {
      chords.push({ heads: [h], x: h.cx, stemX: 0, up, duration: { value: "q", dots: 0 }, articulations: new Set() });
    }
  }
  for (const c of chords) {
    c.heads.sort((a, b) => a.cy - b.cy);
    // Stems up sit on the right edge of the noteheads, stems down on the left.
    c.stemX = up ? Math.max(...c.heads.map((h) => h.x1)) : Math.min(...c.heads.map((h) => h.x0));
  }
  return chords;
}

