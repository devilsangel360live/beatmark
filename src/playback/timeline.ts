import type { InstrumentId } from "../core/drumKit";
import type { Articulation, Score } from "../core/project";
import { measureStartTicks, tieTargets, timeSignatureAt } from "../core/score";
import { beatTicks, PPQ } from "../core/time";

export interface TimelineHit {
  tick: number;
  instrument: InstrumentId;
  articulations: Articulation[];
}

export interface Beat {
  tick: number;
  downbeat: boolean;
}

/** The score flattened to absolute ticks. Playback reads only this, never the source image. */
export interface Timeline {
  hits: TimelineHit[];
  beats: Beat[];
  /** Start tick of each measure, with the score end as the final entry. */
  measureStarts: number[];
  /** Beat length (ticks) and beat count of each measure, for count-ins. */
  measureBeats: { beatTicks: number; count: number }[];
}

/** How far before the main hit grace notes sound: a flam's single grace, or a drag's two. */
export const GRACE_LEAD_TICKS = PPQ / 20;

export function buildTimeline(score: Score): Timeline {
  const measureStarts = measureStartTicks(score);
  const sustained = new Set(tieTargets(score).values());
  const hits: TimelineHit[] = [];
  const beats: Beat[] = [];
  const measureBeats: Timeline["measureBeats"] = [];
  score.measures.forEach((m, i) => {
    const start = measureStarts[i];
    for (const e of m.events) {
      // The second note of a tie continues the first; it isn't struck again.
      if (sustained.has(e.id)) continue;
      const tick = start + e.offset;
      const graces = e.articulations.includes("drag") ? 2 : e.articulations.includes("flam") ? 1 : 0;
      for (let g = graces; g > 0; g--) {
        hits.push({ tick: Math.max(0, tick - g * GRACE_LEAD_TICKS), instrument: e.instrument, articulations: ["ghost"] });
      }
      hits.push({ tick, instrument: e.instrument, articulations: e.articulations });
    }
    const ts = timeSignatureAt(score, i);
    const bt = beatTicks(ts);
    measureBeats.push({ beatTicks: bt, count: ts.beats });
    for (let b = 0; b < ts.beats; b++) beats.push({ tick: start + b * bt, downbeat: b === 0 });
  });
  hits.sort((a, b) => a.tick - b.tick);
  return { hits, beats, measureStarts, measureBeats };
}

/** Which measure an absolute tick falls in, and the offset inside it. */
export function locateTick(timeline: Timeline, tick: number): { measureIndex: number; offset: number } {
  const starts = timeline.measureStarts;
  let i = 0;
  while (i < starts.length - 2 && starts[i + 1] <= tick) i++;
  return { measureIndex: i, offset: tick - starts[i] };
}
