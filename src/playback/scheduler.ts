import type { InstrumentId } from "../core/drumKit";
import type { Articulation } from "../core/project";
import { PPQ } from "../core/time";
import { locateTick, type Timeline } from "./timeline";

export type ScheduledSound =
  | { time: number; kind: "hit"; instrument: InstrumentId; articulations: Articulation[] }
  | { time: number; kind: "click"; downbeat: boolean };

export interface PlayOptions {
  bpm: number;
  /** Half-open tick range [start, end) that plays (or loops). */
  start: number;
  end: number;
  loop: boolean;
  countIn: boolean;
  metronome: boolean;
}

interface Anchor {
  time: number;
  tick: number;
  ticksPerSecond: number;
}

/** Delay before the first sound, so the first window is never already in the past. */
export const START_DELAY = 0.05;
const KEEP_WINDOW = 0.001;

/**
 * Lookahead scheduler, independent of Web Audio so it can be unit-tested.
 *
 * The caller pumps it every ~25 ms with the audio clock's current time. It returns
 * every sound that falls before `now + lookahead`, timed against that clock, so
 * playback never drifts the way per-note timers do. Musical position advances in
 * ticks; tempo only changes how fast ticks map to seconds.
 */
export class Scheduler {
  private timeline: Timeline;
  private opts: PlayOptions;
  private cursorTick: number;
  private cursorTime: number;
  private anchors: Anchor[] = [];
  private pendingCountIn: ScheduledSound[] = [];
  /** After a mid-play tempo change, a hit exactly at the cursor was already kept; don't repeat it. */
  private skipCursorTick = false;
  /** Audio time at which non-looping playback reaches the end, once known. */
  endTime: number | null = null;

  constructor(timeline: Timeline, opts: PlayOptions, now: number, fromTick = opts.start) {
    this.timeline = timeline;
    this.opts = opts;
    this.cursorTick = Math.min(Math.max(fromTick, opts.start), opts.end);
    let t = now + START_DELAY;
    if (opts.countIn) {
      const { measureIndex } = locateTick(timeline, this.cursorTick);
      const { beatTicks, count } = timeline.measureBeats[measureIndex];
      const beatSeconds = beatTicks / this.ticksPerSecond;
      for (let b = 0; b < count; b++) {
        this.pendingCountIn.push({ time: t + b * beatSeconds, kind: "click", downbeat: b === 0 });
      }
      t += count * beatSeconds;
    }
    this.cursorTime = t;
    this.anchors.push({ time: t, tick: this.cursorTick, ticksPerSecond: this.ticksPerSecond });
  }

  private get ticksPerSecond(): number {
    return (this.opts.bpm * PPQ) / 60;
  }

  /** Audio time when the count-in finishes and the score starts. */
  get scoreStartTime(): number {
    return this.anchors[0].time;
  }

  pump(now: number, lookahead: number): ScheduledSound[] {
    const out = this.pendingCountIn.filter((s) => s.time < now + lookahead);
    this.pendingCountIn = this.pendingCountIn.filter((s) => s.time >= now + lookahead);
    const horizon = now + lookahead;
    while (this.cursorTime < horizon && this.endTime === null) {
      const tps = this.ticksPerSecond;
      const reach = this.cursorTick + (horizon - this.cursorTime) * tps;
      const to = Math.min(reach, this.opts.end);
      const from = this.cursorTick;
      const timeOf = (tick: number) => this.cursorTime + (tick - from) / tps;
      const skipFrom = this.skipCursorTick;
      this.skipCursorTick = false;
      const inWindow = (tick: number) => (skipFrom ? tick > from : tick >= from) && tick < to;

      for (const h of this.timeline.hits) {
        if (inWindow(h.tick)) {
          out.push({ time: timeOf(h.tick), kind: "hit", instrument: h.instrument, articulations: h.articulations });
        }
      }
      if (this.opts.metronome) {
        for (const b of this.timeline.beats) {
          if (inWindow(b.tick)) out.push({ time: timeOf(b.tick), kind: "click", downbeat: b.downbeat });
        }
      }

      if (reach >= this.opts.end) {
        const segmentEnd = timeOf(this.opts.end);
        if (this.opts.loop) {
          this.cursorTick = this.opts.start;
          this.cursorTime = segmentEnd;
          this.anchors.push({ time: segmentEnd, tick: this.opts.start, ticksPerSecond: tps });
        } else {
          this.cursorTick = this.opts.end;
          this.cursorTime = segmentEnd;
          this.endTime = segmentEnd;
        }
      } else {
        this.cursorTick = to;
        this.cursorTime = horizon;
      }
    }
    this.pruneAnchors(now);
    return out.sort((a, b) => a.time - b.time);
  }

  /** Score tick audible at `time`, or null during the count-in. */
  tickAt(time: number): number | null {
    let anchor: Anchor | undefined;
    for (const a of this.anchors) if (a.time <= time) anchor = a;
    if (!anchor) return null;
    const tick = anchor.tick + (time - anchor.time) * anchor.ticksPerSecond;
    return Math.min(tick, this.opts.end);
  }

  /**
   * Change tempo from `now` onward. Returns the audio time after which already
   * scheduled sounds must be cancelled; the next pump re-schedules them at the new tempo.
   */
  setTempo(now: number, bpm: number): number {
    if (now < this.scoreStartTime) {
      // During the count-in: keep its clicks, re-time everything after it.
      this.opts = { ...this.opts, bpm };
      this.cursorTick = this.anchors[0].tick;
      this.cursorTime = this.scoreStartTime;
      this.anchors = [{ ...this.anchors[0], ticksPerSecond: this.ticksPerSecond }];
      return this.scoreStartTime - 1e-6;
    }
    // Sounds in the next millisecond stay as scheduled. Re-anchoring just past `now`
    // keeps the cancel boundary off note times, so a hit is never both kept and re-sent.
    const keepUntil = now + KEEP_WINDOW;
    const tick = this.tickAt(keepUntil) ?? this.opts.start;
    this.opts = { ...this.opts, bpm };
    this.cursorTick = tick;
    this.cursorTime = keepUntil;
    this.skipCursorTick = true;
    this.endTime = null;
    this.anchors.push({ time: keepUntil, tick, ticksPerSecond: this.ticksPerSecond });
    return keepUntil;
  }

  setMetronome(on: boolean): void {
    this.opts = { ...this.opts, metronome: on };
  }

  setTimeline(timeline: Timeline): void {
    this.timeline = timeline;
  }

  private pruneAnchors(now: number): void {
    while (this.anchors.length > 1 && this.anchors[1].time <= now) this.anchors.shift();
  }
}
