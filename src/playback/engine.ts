import type { Practice, Score } from "../core/project";
import { renderKit, type SoundId } from "./drumSounds";
import { Scheduler, type ScheduledSound } from "./scheduler";
import { buildTimeline, type Timeline } from "./timeline";

const PUMP_MS = 25;
const LOOKAHEAD_S = 0.1;

export type TransportState = "stopped" | "playing" | "paused";

interface Queued {
  node: AudioBufferSourceNode;
  time: number;
}

/** Binds the pure Scheduler to Web Audio. One instance per app window. */
export class PlaybackEngine {
  private ctx: AudioContext | null = null;
  private kit: Map<SoundId, AudioBuffer> | null = null;
  private scheduler: Scheduler | null = null;
  private timer: number | undefined;
  private queued: Queued[] = [];
  private timeline: Timeline | null = null;
  private pausedTick: number | null = null;
  state: TransportState = "stopped";
  private listeners = new Set<() => void>();

  /** For useSyncExternalStore. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): TransportState => this.state;

  private async ensureAudio(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.kit = await renderKit();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  /** Tick range that plays: the loop if enabled, otherwise the whole score. */
  private range(timeline: Timeline, practice: Practice) {
    const starts = timeline.measureStarts;
    const loop = practice.loop?.enabled ? practice.loop : null;
    if (loop) return { start: starts[loop.startMeasure], end: starts[loop.endMeasure + 1], loop: true };
    return { start: 0, end: starts[starts.length - 1], loop: false };
  }

  async play(score: Score, practice: Practice, fromTick?: number): Promise<void> {
    const ctx = await this.ensureAudio();
    this.halt();
    this.timeline = buildTimeline(score);
    const range = this.range(this.timeline, practice);
    const start = fromTick ?? this.pausedTick ?? range.start;
    this.scheduler = new Scheduler(
      this.timeline,
      { bpm: practice.bpm, ...range, countIn: practice.countIn, metronome: practice.metronome },
      ctx.currentTime,
      start,
    );
    this.pausedTick = null;
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
    this.pump();
    this.setState("playing");
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.pausedTick = this.position();
    this.halt();
    this.setState("paused");
  }

  stop(): void {
    this.halt();
    this.pausedTick = null;
    this.setState("stopped");
  }

  setTempo(bpm: number): void {
    if (!this.ctx || !this.scheduler) return;
    const cancelAfter = this.scheduler.setTempo(this.ctx.currentTime, bpm);
    this.cancelAfter(cancelAfter);
    this.pump();
  }

  setMetronome(on: boolean): void {
    this.scheduler?.setMetronome(on);
  }

  /** Apply score edits made during playback; takes effect from the next lookahead window. */
  updateScore(score: Score): void {
    if (!this.scheduler) return;
    this.timeline = buildTimeline(score);
    this.scheduler.setTimeline(this.timeline);
  }

  /** Current audible score tick, compensated for output latency. Null while stopped or counting in. */
  position(): number | null {
    if (!this.ctx || !this.scheduler) return this.pausedTick;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.scheduler.tickAt(this.ctx.currentTime - latency);
  }

  private pump(): void {
    if (!this.ctx || !this.scheduler) return;
    const now = this.ctx.currentTime;
    for (const s of this.scheduler.pump(now, LOOKAHEAD_S)) this.schedule(s);
    this.queued = this.queued.filter((q) => q.time > now - 2);
    const end = this.scheduler.endTime;
    if (end !== null && now > end + 0.2) this.stop();
  }

  private schedule(s: ScheduledSound): void {
    const ctx = this.ctx!;
    const id: SoundId = s.kind === "click" ? (s.downbeat ? "click-accent" : "click") : s.instrument;
    const buffer = this.kit!.get(id);
    if (!buffer) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = s.kind === "hit" ? velocity(s.articulations) : 1;
    node.connect(gain).connect(ctx.destination);
    node.start(Math.max(s.time, ctx.currentTime));
    this.queued.push({ node, time: s.time });
  }

  private cancelAfter(time: number): void {
    this.queued = this.queued.filter((q) => {
      if (q.time <= time) return true;
      q.node.stop();
      q.node.disconnect();
      return false;
    });
  }

  private halt(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.cancelAfter(-Infinity);
    this.scheduler = null;
  }

  private setState(s: TransportState): void {
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }
}

export const engine = new PlaybackEngine();

if (import.meta.env.DEV) {
  // Lets browser-driven tests inspect transport state.
  (window as unknown as { __beatmarkEngine: PlaybackEngine }).__beatmarkEngine = engine;
}

function velocity(articulations: string[]): number {
  if (articulations.includes("ghost")) return 0.3;
  if (articulations.includes("accent")) return 1;
  return 0.75;
}
