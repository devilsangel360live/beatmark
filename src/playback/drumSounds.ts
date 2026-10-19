import type { InstrumentId } from "../core/drumKit";

export type SoundId = InstrumentId | "click" | "click-accent";

const SAMPLE_RATE = 44100;

type Voice = (ctx: OfflineAudioContext, noise: AudioBuffer) => void;

function decay(ctx: BaseAudioContext, peak: number, seconds: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, 0);
  g.gain.exponentialRampToValueAtTime(0.001, seconds);
  g.connect(ctx.destination);
  return g;
}

function tone(ctx: OfflineAudioContext, type: OscillatorType, from: number, to: number, sweep: number, out: AudioNode) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, 0);
  o.frequency.exponentialRampToValueAtTime(to, sweep);
  o.connect(out);
  o.start(0);
}

function noise(ctx: OfflineAudioContext, buffer: AudioBuffer, filter: BiquadFilterType, freq: number, out: AudioNode) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  src.connect(f).connect(out);
  src.start(0);
}

const tom = (pitch: number): Voice => (ctx) => tone(ctx, "sine", pitch, pitch * 0.6, 0.3, decay(ctx, 0.9, 0.5));

/**
 * Placeholder kit synthesized with Web Audio. Each voice is rendered once to a buffer,
 * so swapping in recorded samples later only changes how buffers are produced.
 */
const VOICES: Record<SoundId, { seconds: number; render: Voice }> = {
  kick: { seconds: 0.45, render: (ctx) => tone(ctx, "sine", 150, 45, 0.12, decay(ctx, 1, 0.4)) },
  snare: {
    seconds: 0.25,
    render: (ctx, n) => {
      noise(ctx, n, "highpass", 1500, decay(ctx, 0.7, 0.2));
      tone(ctx, "triangle", 200, 160, 0.1, decay(ctx, 0.5, 0.1));
    },
  },
  "hihat-closed": { seconds: 0.08, render: (ctx, n) => noise(ctx, n, "highpass", 7000, decay(ctx, 0.5, 0.05)) },
  "hihat-open": { seconds: 0.45, render: (ctx, n) => noise(ctx, n, "highpass", 7000, decay(ctx, 0.45, 0.4)) },
  "hihat-pedal": { seconds: 0.06, render: (ctx, n) => noise(ctx, n, "bandpass", 5000, decay(ctx, 0.4, 0.04)) },
  "tom-high": { seconds: 0.55, render: tom(220) },
  "tom-mid": { seconds: 0.55, render: tom(165) },
  "tom-floor": { seconds: 0.6, render: tom(110) },
  crash: { seconds: 1.6, render: (ctx, n) => noise(ctx, n, "highpass", 4000, decay(ctx, 0.6, 1.5)) },
  ride: {
    seconds: 0.9,
    render: (ctx, n) => {
      noise(ctx, n, "bandpass", 6000, decay(ctx, 0.3, 0.8));
      tone(ctx, "square", 3200, 3100, 0.5, decay(ctx, 0.05, 0.6));
    },
  },
  click: { seconds: 0.04, render: (ctx) => tone(ctx, "sine", 1000, 1000, 0.03, decay(ctx, 0.6, 0.03)) },
  "click-accent": { seconds: 0.04, render: (ctx) => tone(ctx, "sine", 1600, 1600, 0.03, decay(ctx, 0.8, 0.03)) },
};

export async function renderKit(): Promise<Map<SoundId, AudioBuffer>> {
  const entries = await Promise.all(
    (Object.keys(VOICES) as SoundId[]).map(async (id) => {
      const { seconds, render } = VOICES[id];
      const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
      const n = ctx.createBuffer(1, ctx.length, SAMPLE_RATE);
      const data = n.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      render(ctx, n);
      return [id, await ctx.startRendering()] as const;
    }),
  );
  return new Map(entries);
}
