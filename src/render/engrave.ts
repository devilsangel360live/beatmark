import { Annotation, Articulation, Beam, Dot, Formatter, Renderer, Stave, StaveNote, Stem, Voice } from "vexflow/bravura";
import { findInstrument, staffStepToPitch, type InstrumentDef, type Limb } from "../core/drumKit";
import type { Measure, Project } from "../core/project";
import { chordsForLimb, timeSignatureAt, validateMeasure, type MeasureIssue } from "../core/score";
import { durationTicks, measureTicks, restsForGap, type NoteDuration, type TimeSignature } from "../core/time";

const MARGIN_X = 12;
const MARGIN_TOP = 50;
const SYSTEM_HEIGHT = 140;
const CLEF_WIDTH = 40;
const TIME_SIG_WIDTH = 30;

const COLOR_SELECTED = "#1f6feb";
const COLOR_UNRESOLVED = "#c2410c";

/** Geometry of one engraved measure, in on-screen (zoomed) pixels. */
export interface MeasureGeom {
  index: number;
  x: number;
  width: number;
  top: number;
  bottom: number;
  bottomLineY: number;
  lineSpacing: number;
  ticks: number;
  /** Horizontal position of each rhythmic position that has a note or rest, ascending. */
  tickXs: { offset: number; x: number }[];
  issues: MeasureIssue[];
  confidence?: number;
}

export interface NoteHit {
  eventId: string;
  x: number;
  y: number;
}

export interface ScoreLayout {
  measures: MeasureGeom[];
  notes: NoteHit[];
  height: number;
}

interface EngraveOptions {
  width: number;
  selected: Set<string>;
  /** Draw the tempo marking over the first measure. Default true. */
  showTempo?: boolean;
}

/** Draws the score into `host` as SVG and returns the geometry needed for hit-testing and overlays. */
export function engrave(host: HTMLDivElement, project: Project, { width, selected, showTempo = true }: EngraveOptions): ScoreLayout {
  const { score, instrumentMap: map, layout } = project;
  const zoom = layout.zoom;
  const logicalWidth = width / zoom;
  const perSystem = Math.max(1, layout.measuresPerSystem);
  const systems = Math.ceil(score.measures.length / perSystem);
  const height = (MARGIN_TOP + systems * SYSTEM_HEIGHT) * zoom;

  host.innerHTML = "";
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  ctx.scale(zoom, zoom);

  const out: ScoreLayout = { measures: [], notes: [], height };
  const z = (v: number) => v * zoom;

  for (let sys = 0; sys < systems; sys++) {
    const first = sys * perSystem;
    const count = Math.min(perSystem, score.measures.length - first);
    const y = MARGIN_TOP + sys * SYSTEM_HEIGHT;
    const showsTimeSig = (i: number) => i === 0 || !!score.measures[i].timeSignature;
    const extra = CLEF_WIDTH + (showsTimeSig(first) ? TIME_SIG_WIDTH : 0);
    // Size the system as if it were full, so the last system's measures match the others.
    const measureWidth = (logicalWidth - 2 * MARGIN_X - extra) / perSystem;
    let x = MARGIN_X;

    for (let i = first; i < first + count; i++) {
      const measure = score.measures[i];
      const ts = timeSignatureAt(score, i);
      const w = measureWidth + (i === first ? extra : 0) + (i !== first && showsTimeSig(i) ? TIME_SIG_WIDTH : 0);
      const stave = new Stave(x, y, w);
      if (i === first) {
        stave.addClef("percussion");
        stave.setMeasure(score.firstMeasureNumber + i);
      }
      if (showsTimeSig(i)) stave.addTimeSignature(`${ts.beats}/${ts.beatUnit}`);
      // Raised clear of the hi-hat/cymbal beams that sit above the staff.
      if (i === 0 && showTempo) stave.setTempo({ duration: "q", bpm: score.tempo }, -32);
      if (i === score.measures.length - 1) stave.setEndBarType(3); // BarlineType.END
      stave.setContext(ctx).draw();

      // Feet get their own stems-down voice only when the measure has foot notes.
      const limbs = (["hands", "feet"] as Limb[]).filter((l) => l === "hands" || chordsForLimb(measure, map, l).length);
      const built = limbs.map((limb) => buildVoice(measure, map, limb, ts, limbs.length > 1, selected));
      const voices = built.map((b) => b.voice);
      const beams = limbs.flatMap((limb, k) =>
        Beam.generateBeams(
          voices[k].getTickables().filter((t): t is StaveNote => t instanceof StaveNote),
          {
            stemDirection: limb === "hands" ? Stem.UP : Stem.DOWN,
            groups: Beam.getDefaultBeamGroups(`${ts.beats}/${ts.beatUnit}`),
          },
        ),
      );
      new Formatter().joinVoices(voices).formatToStave(voices, stave);
      voices.forEach((v) => v.draw(ctx, stave));
      beams.forEach((b) => b.setContext(ctx).draw());

      const offsetsX = collectTickXs(voices, built.map((b) => b.offsets));
      const ticks = measureTicks(ts);
      offsetsX.push({ offset: ticks, x: stave.getNoteEndX() });

      for (const { note, ids } of built.flatMap((b) => b.hits)) {
        const cx = (note.getNoteHeadBeginX() + note.getNoteHeadEndX()) / 2;
        note.getYs().forEach((ny, k) => out.notes.push({ eventId: ids[k], x: z(cx), y: z(ny) }));
      }

      out.measures.push({
        index: i,
        x: z(x),
        width: z(w),
        top: z(stave.getYForLine(0)),
        bottom: z(stave.getYForLine(4)),
        bottomLineY: z(stave.getYForLine(4)),
        lineSpacing: z(stave.getSpacingBetweenLines()),
        ticks,
        tickXs: offsetsX.map((p) => ({ offset: p.offset, x: z(p.x) })),
        issues: validateMeasure(score, i, map),
        confidence: measure.confidence,
      });
      x += w;
    }
  }
  return out;
}

interface BuiltVoice {
  voice: Voice;
  /** Measure offset of each tickable, in voice order. */
  offsets: number[];
  hits: { note: StaveNote; ids: string[] }[];
}

/** Notes and the rests between them, in time order, for one limb. */
function voiceItems(measure: Measure, map: InstrumentDef[], limb: Limb, ts: TimeSignature) {
  const items: { offset: number; duration: NoteDuration; chord?: ReturnType<typeof chordsForLimb>[number] }[] = [];
  let pos = 0;
  for (const chord of chordsForLimb(measure, map, limb)) {
    if (chord.offset > pos) items.push(...restsForGap(pos, chord.offset, ts));
    items.push({ offset: chord.offset, duration: chord.duration, chord });
    pos = Math.max(pos, chord.offset + durationTicks(chord.duration));
  }
  const end = measureTicks(ts);
  if (pos < end) items.push(...restsForGap(pos, end, ts));
  return items;
}

function collectTickXs(voices: Voice[], offsets: number[][]): { offset: number; x: number }[] {
  const byOffset = new Map<number, number>();
  voices.forEach((v, vi) =>
    v.getTickables().forEach((t, ti) => {
      const offset = offsets[vi][ti];
      const x = t.getAbsoluteX();
      byOffset.set(offset, Math.min(byOffset.get(offset) ?? Infinity, x));
    }),
  );
  return [...byOffset.entries()].sort(([a], [b]) => a - b).map(([offset, x]) => ({ offset, x }));
}

function buildVoice(
  measure: Measure,
  map: InstrumentDef[],
  limb: Limb,
  ts: TimeSignature,
  twoVoices: boolean,
  selected: Set<string>,
): BuiltVoice {
  const stemDirection = limb === "hands" ? Stem.UP : Stem.DOWN;
  const restKey = !twoVoices ? "b/4" : limb === "hands" ? "e/5" : "f/4";
  const items = voiceItems(measure, map, limb, ts);
  const hits: BuiltVoice["hits"] = [];

  const notes = items.map(({ duration, chord }) => {
    if (!chord) {
      const rest = new StaveNote({ keys: [restKey], duration: duration.value, dots: duration.dots, type: "r" });
      if (duration.dots) Dot.buildAndAttach([rest], { all: true });
      return rest;
    }
    // Keys must be in staff order: VexFlow sorts noteheads, and we map them back by index.
    const events = [...chord.events].sort(
      (a, b) => findInstrument(map, a.instrument).staffStep - findInstrument(map, b.instrument).staffStep,
    );
    const keys = events.map((e) => vexKey(findInstrument(map, e.instrument)));
    const note = new StaveNote({ keys, duration: duration.value, dots: duration.dots, stemDirection });
    if (duration.dots) Dot.buildAndAttach([note], { all: true });
    events.forEach((e, k) => {
      if (selected.has(e.id)) note.setKeyStyle(k, { fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
      else if (e.unresolved) note.setKeyStyle(k, { fillStyle: COLOR_UNRESOLVED, strokeStyle: COLOR_UNRESOLVED });
      if (e.articulations.includes("accent")) note.addModifier(new Articulation("a>").setPosition("above"), k);
    });
    // Color alone isn't enough to mark something needing review (NFR-05).
    if (events.some((e) => e.unresolved)) note.addModifier(new Annotation("?").setVerticalJustification(1), 0);
    hits.push({ note, ids: events.map((e) => e.id) });
    return note;
  });

  const voice = new Voice({ numBeats: ts.beats, beatValue: ts.beatUnit }).setMode(Voice.Mode.SOFT);
  voice.addTickables(notes);
  return { voice, offsets: items.map((i) => i.offset), hits };
}

function vexKey(def: InstrumentDef): string {
  const { step, octave } = staffStepToPitch(def.staffStep);
  const head = def.notehead === "x" ? "/x2" : def.notehead === "circle-x" ? "/x3" : "";
  return `${step.toLowerCase()}/${octave}${head}`;
}

// ---- Geometry helpers used by the score view. ----

export function xForOffset(m: MeasureGeom, offset: number): number {
  const pts = m.tickXs;
  if (offset <= pts[0].offset) return pts[0].x;
  for (let i = 1; i < pts.length; i++) {
    if (offset <= pts[i].offset) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.x + ((offset - a.offset) / (b.offset - a.offset)) * (b.x - a.x);
    }
  }
  return pts[pts.length - 1].x;
}

export function offsetForX(m: MeasureGeom, x: number): number {
  const pts = m.tickXs;
  if (x <= pts[0].x) return pts[0].offset;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.offset + ((x - a.x) / (b.x - a.x || 1)) * (b.offset - a.offset);
    }
  }
  return m.ticks;
}

/** Staff step under a y coordinate: 0 = bottom line, 1 = bottom space, ... */
export function staffStepForY(m: MeasureGeom, y: number): number {
  return Math.round((m.bottomLineY - y) / (m.lineSpacing / 2));
}
