#!/usr/bin/env node
/**
 * Generate labelled synthetic training images.
 *
 *   cd training && node synth/generate.mjs --count 20000 --out data/synth
 *
 * Writes:
 *   <out>/train/images/000123.png   one staff system per image, 16 px staff space
 *   <out>/train/labels.jsonl        one line per image: its symbol boxes and class ids
 *   <out>/val/...                   same, for the held-out validation split
 */
import { mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "1000" },
    out: { type: "string" },
    val: { type: "string", default: "0.05" },
    workers: { type: "string", default: "4" },
    seed: { type: "string", default: "1" },
    clean: { type: "boolean", default: false },
  },
});
const count = Number(args.count);
// Relative to where you run the command; defaults to training/data/synth.
const out = args.out ? resolve(args.out) : join(root, "training", "data", "synth");
const valFraction = Number(args.val);
const firstSeed = Number(args.seed);

const VEXFLOW_FONTS = ["Bravura", "Gonville", "Petaluma"];
const VEROVIO_FONTS = ["Leipzig", "Bravura", "Gootville", "Leland", "Petaluma"];

if (args.clean) await rm(out, { recursive: true, force: true });
for (const split of ["train", "val"]) await mkdir(join(out, split, "images"), { recursive: true });

// Serve the generator page with the app's own Vite config, on a port that won't clash with `tauri dev`.
const server = await createServer({
  root,
  server: { port: 5199, strictPort: false },
  // Vite's dependency pre-bundling corrupts Verovio's embedded WebAssembly; serve it as-is.
  optimizeDeps: { exclude: ["verovio"] },
  logLevel: "error",
});
await server.listen();
const url = `${server.resolvedUrls.local[0]}training/synth/index.html`;

const browser = await chromium.launch({ channel: "chrome" });
let done = 0;
let failed = 0;
const started = Date.now();

async function worker(workerIndex, seeds) {
  const page = await browser.newPage({ viewport: { width: 4000, height: 800 } });
  page.on("pageerror", (e) => console.error(`[worker ${workerIndex}]`, e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.synth);
  await page.evaluate(() => window.synth.ready);

  for (const seed of seeds) {
    // Deterministic per seed: the same seed always produces the same image and labels.
    const split = hash(seed) % 1000 < valFraction * 1000 ? "val" : "train";
    const r = seed * 2654435761 % 1000 / 1000;
    const engraver = r < 0.5 ? "vexflow" : "verovio";
    const fonts = engraver === "vexflow" ? VEXFLOW_FONTS : VEROVIO_FONTS;
    const font = fonts[seed % fonts.length];
    const scaleJitter = 0.9 + ((seed * 7919) % 200) / 1000;
    try {
      const res = await page.evaluate((req) => window.synth.render(req), { seed, engraver, font, scaleJitter });
      const png = await page.screenshot({ clip: res.clip });
      const name = `${String(seed).padStart(7, "0")}.png`;
      await writeFile(join(out, split, "images", name), png);
      const record = {
        image: `images/${name}`,
        width: res.clip.width,
        height: res.clip.height,
        staff_space: res.staffSpace,
        engraver,
        font,
        seed,
        boxes: res.boxes,
      };
      await appendFile(join(out, split, "labels.jsonl"), JSON.stringify(record) + "\n");
    } catch (e) {
      failed++;
      console.error(`seed ${seed} (${engraver}/${font}) failed: ${e.message.split("\n")[0]}`);
    }
    done++;
    if (done % 100 === 0 || done === count) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`${done}/${count}  ${rate.toFixed(1)} img/s  ~${Math.round((count - done) / rate / 60)} min left`);
    }
  }
  await page.close();
}

function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

const workers = Number(args.workers);
const seeds = Array.from({ length: count }, (_, i) => firstSeed + i);
await Promise.all(
  Array.from({ length: workers }, (_, w) => worker(w, seeds.filter((_, i) => i % workers === w))),
);
await browser.close();
await server.close();
console.log(`Done: ${done - failed} images in ${out} (${failed} failed).`);
