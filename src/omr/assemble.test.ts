import { describe, expect, it } from "vitest";
import { DRUMEO_KEY } from "../core/drumKit";
import { assemble, type Detection, type RecognizedStaff } from "./assemble";

// A normalized staff: lines 16 px apart from y = 96 (top) to 160 (bottom). Staff step s sits at
// y = 160 - 8s: kick (1) 152, snare (5) 120, hi-hat (9) 88, hi-hat foot (-1) 168.
const y = (step: number) => 160 - 8 * step;
const head = (cls: string, x: number, step: number, score = 0.99): Detection => ({ class: cls, score, bbox: [x, y(step) - 8, x + 20, y(step) + 8] });
const box = (cls: string, x0: number, y0: number, x1: number, y1: number, score = 0.99): Detection => ({ class: cls, score, bbox: [x0, y0, x1, y1] });

function staff(symbols: Detection[], barlines: number[] = [], width = 800): RecognizedStaff {
  return { pageBox: [0, 0, width, 256], cropWidth: width, cropHeight: 256, topLine: 96, bottomLine: 160, barlines, symbols };
}

const run = (...staves: RecognizedStaff[]) => assemble([{ sourceId: "src", recognition: { staves, deskew: 0, warnings: [] } }], DRUMEO_KEY);
const summary = (r: ReturnType<typeof run>, m = 0) =>
  [...r.measures[m].events].sort((a, b) => a.offset - b.offset || a.instrument.localeCompare(b.instrument)).map((e) => `${e.offset}:${e.instrument}:${e.duration.value}${e.duration.tuplet ? "t" : ""}${e.articulations.length ? ":" + e.articulations.join(",") : ""}`);

/** A 4/4 bar of hi-hat eighths with kick on 1 and 3 and snare on 2 and 4, all stems up (Drumeo style). */
function rockBar(x0: number): Detection[] {
  const out: Detection[] = [];
  for (let i = 0; i < 8; i++) {
    const x = x0 + i * 40;
    out.push(head("head_x", x, 9));
    if (i === 0 || i === 4) out.push(head("head_black", x, 1));
    if (i === 2 || i === 6) out.push(head("head_black", x, 5));
  }
  // One beam per pair of eighths, above the staff.
  for (let i = 0; i < 8; i += 2) out.push(box("beam", x0 + i * 40 + 18, 30, x0 + (i + 1) * 40 + 22, 38));
  return out;
}

describe("assemble", () => {
  it("reads a beamed groove where kick shares the cymbal stems", () => {
    const r = run(staff([box("timesig_4", 40, 96, 60, 128), box("timesig_4", 40, 128, 60, 160), ...rockBar(80)], [420]));
    expect(r.timeSignature).toEqual({ beats: 4, beatUnit: 4 });
    expect(r.measures).toHaveLength(1);
    // The kick shared the cymbals' eighth-note stems; in Beatmark's own stems-down feet voice it
    // is re-notated to last until the next kick (same timing, no clutter of rests).
    expect(summary(r)).toEqual([
      "0:hihat-closed:8", "0:kick:h",
      "240:hihat-closed:8",
      "480:hihat-closed:8", "480:snare:8",
      "720:hihat-closed:8",
      "960:hihat-closed:8", "960:kick:h",
      "1200:hihat-closed:8",
      "1440:hihat-closed:8", "1440:snare:8",
      "1680:hihat-closed:8",
    ]);
    expect(r.measures[0].confidence).toBeGreaterThan(0.9);
  });

  it("counts a secondary beam split into pieces as one level", () => {
    // Four 16ths: a primary beam over all, and the second beam detected as three pieces.
    const notes = [0, 1, 2, 3].map((i) => head("head_black", 100 + i * 30, 5));
    const beams = [box("beam", 118, 30, 212, 38), box("beam", 118, 42, 152, 48), box("beam", 148, 42, 182, 48), box("beam", 178, 42, 212, 48)];
    const r = run(staff([...notes, ...beams, box("rest_half", 300, 112, 330, 120), box("rest_quarter", 260, 108, 275, 140)], [400]));
    expect(summary(r)).toEqual(["0:snare:16", "120:snare:16", "240:snare:16", "360:snare:16"]);
    expect(r.measures[0].confidence).toBeGreaterThan(0.9);
  });

  it("never stretches a re-notated note over a printed rest", () => {
    // 4/4: quarter, printed quarter rest, quarter, printed quarter rest.
    // the first note must stay a quarter so the rest on beat 2 survives.
    const r = run(staff([head("head_black", 100, 5), box("rest_quarter", 150, 108, 165, 140), head("head_black", 200, 5), box("rest_quarter", 250, 108, 265, 140)], [400]));
    expect(summary(r)).toEqual(["0:snare:q", "960:snare:q"]);
  });

  it("makes the chord after grace notes a flam or drag", () => {
    const r = run(
      staff([
        box("grace_head", 70, 114, 82, 124),
        head("head_black", 90, 5),
        box("grace_head", 150, 114, 162, 124),
        box("grace_head", 166, 114, 178, 124),
        head("head_black", 190, 5),
        box("rest_half", 300, 112, 330, 120),
      ], [400]),
    );
    expect(summary(r)).toEqual(["0:snare:q:flam", "480:snare:q:drag"]);
  });

  it("expands a multi-bar rest by the number printed above it", () => {
    const r = run(staff([box("multirest", 100, 120, 500, 136, 0.4), box("timesig_8", 290, 60, 310, 90), box("timesig_3", 291, 62, 309, 88, 0.6)], [40, 700]));
    expect(r.measures).toHaveLength(8);
    expect(r.measures.every((m) => m.events.length === 0)).toBe(true);
    // A weak multi-rest detection is kept but marked for review.
    expect(r.measures[0].confidence).toBeLessThan(0.55);
  });

  it("reads a triplet group from its 3", () => {
    const notes = [0, 1, 2].map((i) => head("head_black", 100 + i * 30, 5));
    const r = run(staff([...notes, box("beam", 118, 30, 182, 38), box("tuplet_3", 140, 10, 152, 24), box("rest_half", 300, 112, 330, 120), box("rest_quarter", 260, 108, 275, 140)], [400]));
    expect(summary(r)).toEqual(["0:snare:8t", "160:snare:8t", "320:snare:8t"]);
    expect(r.measures[0].confidence).toBeGreaterThan(0.9);
  });

  it("flags a bar whose notes don't add up instead of guessing", () => {
    // Three quarter notes in 4/4, nothing else.
    const r = run(staff([0, 1, 2].map((i) => head("head_black", 100 + i * 60, 5)), [400]));
    expect(r.measures[0].confidence).toBeLessThan(0.55);
    expect(r.stats.flagged).toBe(1);
  });

  it("separates a stems-down feet voice when beams hang below the staff", () => {
    // 2/4. Hands: two hi-hat quarters. Feet, stems down: two kick eighths beamed below, then a quarter rest.
    const hands = [head("head_x", 100, 9), head("head_x", 200, 9)];
    const feet = [head("head_black", 100, 1), head("head_black", 140, 1), box("beam", 98, 190, 142, 198), box("rest_quarter", 200, 150, 215, 180)];
    const r = run(staff([box("timesig_2", 40, 96, 60, 128), box("timesig_4", 40, 128, 60, 160), ...hands, ...feet], [300]));
    expect(summary(r)).toEqual(["0:hihat-closed:q", "0:kick:8", "240:kick:8", "480:hihat-closed:q"]);
    expect(r.measures[0].confidence).toBeGreaterThan(0.9);
  });

  it("marks a notehead with no drum at its position as unresolved", () => {
    // Step 11: above the crash, where the default drum key has nothing.
    const r = run(staff([head("head_x", 100, 11), box("rest_half", 300, 112, 330, 120), box("rest_quarter", 260, 108, 275, 140)], [400]));
    const e = r.measures[0].events[0];
    expect(e.instrument).toBe("crash");
    expect(e.unresolved).toBe(true);
  });
});
