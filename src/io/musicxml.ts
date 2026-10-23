import { findInstrument, staffStepToPitch, type InstrumentDef, type Limb } from "../core/drumKit";
import type { NoteEvent, Project } from "../core/project";
import { chordsForLimb, tieTargets, timeSignatureAt, tupletGroups, validateMeasure } from "../core/score";
import { durationTicks, measureTicks, PPQ, restsForGap, type DurationValue, type NoteDuration } from "../core/time";

const TYPE_NAMES: Record<DurationValue, string> = {
  w: "whole",
  h: "half",
  q: "quarter",
  "8": "eighth",
  "16": "16th",
  "32": "32nd",
};

const VOICE_NUMBER: Record<Limb, number> = { hands: 1, feet: 2 };

export interface ExportResult {
  xml: string;
  /** User-facing notes about anything that didn't export faithfully. */
  warnings: string[];
}

/** MusicXML 4.0 partwise export of the supported drum subset. */
export function exportMusicXml(project: Project): ExportResult {
  const { score, instrumentMap: map, metadata } = project;
  const warnings: string[] = [];
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">`,
    `<score-partwise version="4.0">`,
    `  <work><work-title>${esc(metadata.title)}</work-title></work>`,
    `  <part-list>`,
    `    <score-part id="P1">`,
    `      <part-name>Drumset</part-name>`,
    ...map.map((d) => `      <score-instrument id="${instId(d)}"><instrument-name>${esc(d.name)}</instrument-name></score-instrument>`),
    ...map.map(
      (d) =>
        `      <midi-instrument id="${instId(d)}"><midi-channel>10</midi-channel><midi-unpitched>${d.midi + 1}</midi-unpitched></midi-instrument>`,
    ),
    `    </score-part>`,
    `  </part-list>`,
    `  <part id="P1">`,
  ];

  let unresolved = 0;
  const invalidMeasures: number[] = [];
  const ties = tieTargets(score);
  const tiedTo = new Set(ties.values());

  score.measures.forEach((measure, i) => {
    const ts = timeSignatureAt(score, i);
    const length = measureTicks(ts);
    const number = score.firstMeasureNumber + i;
    lines.push(`    <measure number="${number}">`);
    if (i === 0 || measure.timeSignature) {
      lines.push(
        `      <attributes>`,
        ...(i === 0 ? [`        <divisions>${PPQ}</divisions>`, `        <key><fifths>0</fifths></key>`] : []),
        `        <time><beats>${ts.beats}</beats><beat-type>${ts.beatUnit}</beat-type></time>`,
        ...(i === 0 ? [`        <clef><sign>percussion</sign><line>2</line></clef>`] : []),
        `      </attributes>`,
      );
    }
    if (i === 0) {
      lines.push(
        `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`,
      );
    }
    if (measure.dynamic) {
      lines.push(`      <direction placement="below"><direction-type><dynamics><${measure.dynamic}/></dynamics></direction-type></direction>`);
    }
    if (validateMeasure(score, i, map).length) invalidMeasures.push(number);

    const limbs: Limb[] = chordsForLimb(measure, map, "feet").length ? ["hands", "feet"] : ["hands"];
    limbs.forEach((limb, k) => {
      if (k > 0) lines.push(`      <backup><duration>${length}</duration></backup>`);
      const items: VoiceItem[] = [];
      let pos = 0;
      for (const chord of chordsForLimb(measure, map, limb)) {
        if (chord.offset > pos) restsForGap(pos, chord.offset, ts).forEach((r) => items.push({ ...r }));
        items.push({ offset: chord.offset, duration: chord.duration, chord: chord.events });
        pos = Math.max(pos, chord.offset + durationTicks(chord.duration));
      }
      if (pos < length) restsForGap(pos, length, ts).forEach((r) => items.push({ ...r }));

      const beams = beamsFor(items, beamGroupTicks(ts));
      const tuplets = new Map<number, { tuplet: 3 | 6; edge?: "start" | "stop" }>();
      for (const g of tupletGroups(items)) {
        for (let t = g.first; t <= g.last; t++) {
          tuplets.set(t, { tuplet: g.tuplet, edge: t === g.first ? "start" : t === g.last ? "stop" : undefined });
        }
      }
      items.forEach((item, i) => {
        if (!item.chord) return lines.push(rest(item.duration, limb));
        // Grace notes precede the whole chord.
        for (const e of item.chord) lines.push(...graceNotes(e, findInstrument(map, e.instrument), limb));
        item.chord.forEach((e, j) => {
          if (e.unresolved) unresolved++;
          lines.push(
            note(e, findInstrument(map, e.instrument), item.duration, limb, {
              chord: j > 0,
              // Beams belong to the chord's stem, so only the first note carries them.
              beams: j === 0 ? beams[i] : [],
              tuplet: tuplets.get(i),
              tieStart: ties.has(e.id),
              tieStop: tiedTo.has(e.id),
            }),
          );
        });
      });
    });
    if (i === score.measures.length - 1) {
      lines.push(`      <barline location="right"><bar-style>light-heavy</bar-style></barline>`);
    }
    lines.push(`    </measure>`);
  });

  lines.push(`  </part>`, `</score-partwise>`, ``);

  if (unresolved) {
    warnings.push(`${unresolved} note(s) still marked for review were exported as they currently appear.`);
  }
  if (invalidMeasures.length) {
    warnings.push(
      `Measure(s) ${invalidMeasures.join(", ")} have overlapping or overflowing notes; other apps may display them differently.`,
    );
  }
  if (project.sources.length || project.practice.loop) {
    warnings.push("Source images and practice settings (loop, playback tempo) are kept only in the Beatmark project file.");
  }
  return { xml: lines.join("\n"), warnings };
}

interface VoiceItem {
  offset: number;
  duration: NoteDuration;
  /** Absent for rests. */
  chord?: NoteEvent[];
}

const BEAM_LEVELS: Partial<Record<DurationValue, number>> = { "8": 1, "16": 2, "32": 3 };

/** Notes are beamed within one beat, or within a dotted-quarter group in compound meters like 6/8. */
export function beamGroupTicks(ts: { beats: number; beatUnit: number }): number {
  if (ts.beatUnit === 8 && ts.beats % 3 === 0) return PPQ * 1.5;
  return PPQ;
}

/**
 * MusicXML <beam> values for each item, e.g. ["1:begin", "2:begin"]. Without them, other
 * apps draw every eighth note with its own flag instead of joining them with beams.
 */
export function beamsFor(items: VoiceItem[], groupTicks: number): string[][] {
  const out: string[][] = items.map(() => []);
  const levelOf = (i: number) => (items[i].chord ? (BEAM_LEVELS[items[i].duration.value] ?? 0) : 0);
  const groupOf = (i: number) => Math.floor(items[i].offset / groupTicks);

  // Runs of consecutive beamable notes inside one beam group; rests break a run.
  let i = 0;
  while (i < items.length) {
    if (!levelOf(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < items.length && levelOf(j + 1) && groupOf(j + 1) === groupOf(i)) j++;
    if (j > i) {
      for (let level = 1; level <= 3; level++) {
        for (let k = i; k <= j; k++) {
          if (levelOf(k) < level) continue;
          const prev = k > i && levelOf(k - 1) >= level;
          const next = k < j && levelOf(k + 1) >= level;
          const kind = prev && next ? "continue" : prev ? "end" : next ? "begin" : k === j ? "backward hook" : "forward hook";
          out[k].push(`${level}:${kind}`);
        }
      }
    }
    i = j + 1;
  }
  return out;
}

interface NoteMarks {
  chord: boolean;
  beams: string[];
  /** Where this note sits in a tuplet group; groups carry <time-modification> on every note. */
  tuplet?: { tuplet: 3 | 6; edge?: "start" | "stop" };
  tieStart: boolean;
  tieStop: boolean;
}

function note(e: NoteEvent, def: InstrumentDef, d: NoteDuration, limb: Limb, marks: NoteMarks): string {
  const notations = [
    marks.tieStop ? `<tied type="stop"/>` : "",
    marks.tieStart ? `<tied type="start"/>` : "",
    marks.tuplet?.edge ? `<tuplet type="${marks.tuplet.edge}" bracket="no"/>` : "",
    e.articulations.includes("accent") ? "<articulations><accent/></articulations>" : "",
  ].join("");
  const parts = [
    marks.chord ? "<chord/>" : "",
    unpitched(def),
    `<duration>${durationTicks(d)}</duration>`,
    marks.tieStop ? `<tie type="stop"/>` : "",
    marks.tieStart ? `<tie type="start"/>` : "",
    `<instrument id="${instId(def)}"/>`,
    `<voice>${VOICE_NUMBER[limb]}</voice>`,
    `<type>${TYPE_NAMES[d.value]}</type>`,
    d.dots ? "<dot/>" : "",
    marks.tuplet
      ? `<time-modification><actual-notes>${marks.tuplet.tuplet}</actual-notes><normal-notes>${marks.tuplet.tuplet === 3 ? 2 : 4}</normal-notes></time-modification>`
      : "",
    `<stem>${limb === "hands" ? "up" : "down"}</stem>`,
    noteheadXml(def, e),
    ...marks.beams.map((b) => {
      const [number, kind] = b.split(":");
      return `<beam number="${number}">${kind}</beam>`;
    }),
    notations ? `<notations>${notations}</notations>` : "",
  ];
  return `      <note>${parts.join("")}</note>`;
}

function unpitched(def: InstrumentDef): string {
  const { step, octave } = staffStepToPitch(def.staffStep);
  return `<unpitched><display-step>${step}</display-step><display-octave>${octave}</display-octave></unpitched>`;
}

function noteheadXml(def: InstrumentDef, e?: NoteEvent): string {
  if (def.notehead === "x") return "<notehead>x</notehead>";
  if (def.notehead === "circle-x") return "<notehead>circle-x</notehead>";
  return e?.articulations.includes("ghost") ? `<notehead parentheses="yes">normal</notehead>` : "";
}

/** Grace notes written before the principal note: a slashed eighth (flam) or two beamed 16ths (drag). */
function graceNotes(e: NoteEvent, def: InstrumentDef, limb: Limb): string[] {
  const kind = e.articulations.includes("drag") ? "drag" : e.articulations.includes("flam") ? "flam" : null;
  if (!kind) return [];
  const common = (type: string, extra = "") =>
    `${unpitched(def)}<instrument id="${instId(def)}"/><voice>${VOICE_NUMBER[limb]}</voice><type>${type}</type><stem>up</stem>${noteheadXml(def)}${extra}`;
  if (kind === "flam") return [`      <note><grace slash="yes"/>${common("eighth")}</note>`];
  return ["begin", "end"].map(
    (edge) => `      <note><grace/>${common("16th", `<beam number="1">${edge}</beam><beam number="2">${edge}</beam>`)}</note>`,
  );
}

function rest(d: NoteDuration, limb: Limb): string {
  return `      <note><rest/><duration>${durationTicks(d)}</duration><voice>${VOICE_NUMBER[limb]}</voice><type>${TYPE_NAMES[d.value]}</type>${d.dots ? "<dot/>" : ""}</note>`;
}

function instId(d: InstrumentDef): string {
  return `P1-I${d.midi + 1}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
