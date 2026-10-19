/**
 * Browser side of the synthetic data generator. `generate.mjs` opens this page in headless
 * Chrome and calls `window.synth.render(...)` once per sample. The page draws a random groove
 * with one of two engravers, then reads every music symbol's box straight from the SVG, so
 * labels are exact and free.
 */
import VexFlow from "vexflow";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { exportMusicXml } from "../../src/io/musicxml";
import { engrave } from "../../src/render/engrave";
import classesFile from "../classes.json";
import { makeRng, randomGroove } from "./grooves";

export interface SampleRequest {
  seed: number;
  engraver: "vexflow" | "verovio";
  font: string;
  /** Multiplier on the 16 px staff space, so the model tolerates imperfect scale estimates. */
  scaleJitter: number;
}

export interface SampleResult {
  /** Page region to screenshot. */
  clip: { x: number; y: number; width: number; height: number };
  /** [classId, x0, y0, x1, y1] relative to the clip. */
  boxes: [number, number, number, number, number][];
  staffSpace: number;
}

const { classes, normalization } = classesFile;
const TARGET_SPACE = normalization.staff_space_px;
const BEAM = classes.findIndex((c) => c.name === "beam");
const DOT = classes.findIndex((c) => c.name === "dot");
const CLASS_BY_CODEPOINT = new Map<string, number>();
classes.forEach((c, i) => c.smufl.forEach((cp) => CLASS_BY_CODEPOINT.set(cp.toUpperCase(), i)));

const stage = document.getElementById("stage") as HTMLDivElement;
const measureCtx = document.createElement("canvas").getContext("2d")!;
let verovio: VerovioToolkit | null = null;
/** Verovio scale (percent) giving the target staff space, calibrated once per font. */
const verovioScale = new Map<string, number>();

async function render(req: SampleRequest): Promise<SampleResult> {
  const project = randomGroove(req.seed);
  const rng = makeRng(req.seed ^ 0x5eed);
  const space = TARGET_SPACE * req.scaleJitter;
  stage.innerHTML = "";

  if (req.engraver === "vexflow") {
    VexFlow.setFonts(req.font, "Academico");
    // VexFlow's staff space is 10 px at zoom 1.
    project.layout.zoom = space / 10;
    const host = document.createElement("div");
    stage.appendChild(host);
    // Give crowded measures room (VexFlow lets notes spill past a too-narrow stave), plus random slack.
    const busiest = Math.max(...project.score.measures.map((m) => new Set(m.events.map((e) => e.offset)).size + 2));
    const perMeasure = Math.max(160, busiest * 30) * (1 + rng.next() * 0.6);
    const width = (project.score.measures.length * perMeasure + 90) * project.layout.zoom;
    engrave(host, project, { width, selected: new Set(), showTempo: rng.chance(0.4) });
  } else {
    const tk = await getVerovio();
    const xml = exportMusicXml(project).xml;
    const base = await calibratedScale(tk, req.font, xml);
    tk.setOptions({ ...verovioOptions(req.font, base * req.scaleJitter), spacingNonLinear: 0.5 + rng.next() * 0.3 });
    tk.loadData(xml);
    stage.innerHTML = tk.renderToSVG(1);
  }

  const svg = stage.querySelector("svg")!;
  const lines = staffLines(svg);
  if (lines.length < 5) throw new Error(`Found ${lines.length} staff lines`);
  const measured = (lines[4] - lines[0]) / 4;
  const svgRect = svg.getBoundingClientRect();
  const clip = {
    x: Math.floor(svgRect.left),
    y: Math.floor(lines[0] - normalization.crop_spaces_above_top_line * measured),
    width: Math.ceil(contentRight(svg) - svgRect.left + measured * 2),
    height: Math.round((4 + normalization.crop_spaces_above_top_line + normalization.crop_spaces_below_bottom_line) * measured),
  };
  return { clip, boxes: collectBoxes(svg, clip), staffSpace: measured };
}

function verovioOptions(font: string, scale: number) {
  return {
    font,
    scale,
    breaks: "none",
    adjustPageHeight: true,
    adjustPageWidth: true,
    header: "none",
    footer: "none",
    pageMarginTop: 200,
    pageMarginBottom: 200,
    pageMarginLeft: 40,
    pageMarginRight: 40,
  };
}

async function getVerovio(): Promise<VerovioToolkit> {
  if (!verovio) verovio = new VerovioToolkit(await createVerovioModule());
  return verovio;
}

/** Render once at scale 100, measure the staff space, and solve for the scale that gives 16 px. */
async function calibratedScale(tk: VerovioToolkit, font: string, xml: string): Promise<number> {
  const cached = verovioScale.get(font);
  if (cached) return cached;
  tk.setOptions(verovioOptions(font, 100));
  tk.loadData(xml);
  stage.innerHTML = tk.renderToSVG(1);
  const lines = staffLines(stage.querySelector("svg")!);
  const scale = (100 * TARGET_SPACE) / ((lines[4] - lines[0]) / 4);
  verovioScale.set(font, scale);
  return scale;
}

/** Y positions of the first staff's five lines: long, thin, horizontal paths. */
function staffLines(svg: SVGSVGElement): number[] {
  const ys = new Set<number>();
  svg.querySelectorAll("path, line").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 60 && r.height < 4) ys.add(Math.round((r.top + r.bottom) / 2));
  });
  return [...ys].sort((a, b) => a - b).slice(0, 5);
}

function contentRight(svg: SVGSVGElement): number {
  const limit = svg.getBoundingClientRect().right;
  let right = 0;
  svg.querySelectorAll("path, text, use, polygon, rect").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 4000) right = Math.max(right, r.right);
  });
  return Math.min(right, limit);
}

function collectBoxes(svg: SVGSVGElement, clip: SampleResult["clip"]): SampleResult["boxes"] {
  const raw: [number, DOMRect][] = [];
  // Glyphs: VexFlow draws <text> with a SMuFL character; Verovio draws <use href="#E0A4-...">.
  const classOf = (cp: string | undefined) => (cp ? CLASS_BY_CODEPOINT.get(cp.toUpperCase()) : undefined);
  svg.querySelectorAll("text").forEach((t) => {
    // One <text> can hold several glyphs, e.g. the "1" and "2" of a 12/8 time signature.
    [...(t.textContent ?? "")].forEach((ch, k) => {
      const cls = classOf(ch.codePointAt(0)?.toString(16));
      if (cls !== undefined) raw.push([cls, inkRect(t, k)]);
    });
  });
  svg.querySelectorAll("use").forEach((u) => {
    const href = u.getAttribute("href") ?? u.getAttribute("xlink:href") ?? "";
    const cls = classOf(/^#?([0-9A-F]{4})/i.exec(href)?.[1]);
    if (cls !== undefined) raw.push([cls, u.getBoundingClientRect()]);
  });
  // Beams are plain filled shapes, one per beam line. Verovio draws dots as ellipses.
  svg.querySelectorAll(".vf-beam path, .beam > polygon").forEach((b) => raw.push([BEAM, b.getBoundingClientRect()]));
  svg.querySelectorAll(".dots ellipse").forEach((d) => raw.push([DOT, d.getBoundingClientRect()]));

  // Ink outside the SVG's own area isn't drawn, so it must not be labelled either.
  const view = svg.getBoundingClientRect();
  const out: SampleResult["boxes"] = [];
  for (const [cls, r] of raw) {
    const x0 = Math.max(0, r.left - clip.x, view.left - clip.x);
    const y0 = Math.max(0, r.top - clip.y, view.top - clip.y);
    const x1 = Math.min(clip.width, r.right - clip.x, view.right - clip.x);
    const y1 = Math.min(clip.height, r.bottom - clip.y, view.bottom - clip.y);
    const visible = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    // Drop symbols mostly cut off by the crop (e.g. tempo marks far above the staff).
    if (visible < 0.6 * r.width * r.height || x1 - x0 < 2 || y1 - y0 < 2) continue;
    out.push([cls, round(x0), round(y0), round(x1), round(y1)]);
  }
  return out;
}

/**
 * Tight box around a <text> glyph's ink. getBoundingClientRect on text returns the
 * whole line box (far too tall), so measure the glyph with canvas text metrics instead.
 */
function inkRect(t: SVGTextElement, index = 0): DOMRect {
  const cs = getComputedStyle(t);
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const chars = [...(t.textContent ?? "")];
  const m = measureCtx.measureText(chars[index]);
  // Glyphs before this one shift it right by their advance width.
  const x = Number(t.getAttribute("x") ?? 0) + measureCtx.measureText(chars.slice(0, index).join("")).width;
  const y = Number(t.getAttribute("y") ?? 0);
  const ctm = t.getScreenCTM()!;
  const a = new DOMPoint(x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent).matrixTransform(ctm);
  const b = new DOMPoint(x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent).matrixTransform(ctm);
  return new DOMRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

const round = (v: number) => Math.round(v * 10) / 10;

async function ready(): Promise<void> {
  await Promise.all(["Bravura", "Gonville", "Petaluma", "Academico"].map((f) => document.fonts.load(`30px ${f}`)));
  await getVerovio();
}

declare global {
  interface Window {
    synth: { ready: Promise<void>; render: typeof render };
  }
}
window.synth = { ready: ready(), render };
