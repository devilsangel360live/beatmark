# Drum notation recognition: training plan

> **To train a model, follow [GUIDE.md](GUIDE.md).** It's a step-by-step walkthrough with every command. This file holds the design reasoning and accuracy targets.

The app's recognition boundary is `src-tauri/src/omr/mod.rs`. This folder will hold the offline Python pipeline that produces the model it runs. Python is used only to make the model. The app ships an ONNX file and runs it from Rust with the `ort` crate.

## Pipeline

```
image ─► preprocess ─► staff finding ─► symbol detection ─► assembly ─► confidence ─► Measure[]
         (Rust, CV)    (Rust, CV)       (ONNX model)        (Rust rules) (Rust rules)
```

Only symbol detection is learned. Everything else is deterministic code, which keeps the model small and its failures easy to understand.

1. **Preprocess:** grayscale, binarize (Sauvola), deskew from the dominant horizontal-line angle.
2. **Staff finding:** horizontal projection gives the five-line groups and the **staff space** (distance between lines). Barlines are vertical runs that span exactly one staff.
3. **Normalize scale:** crop each system and rescale it so the staff space is a fixed 16 px. **This is the most important step.** A screenshot at any resolution looks identical to the model, so it only has to learn one size of notehead.
4. **Detect symbols** in each normalized system crop (see below).
5. **Assemble:** notehead y → staff step → drum key → instrument. Stems are found with CV and attached to noteheads; stem direction → voice; noteheads on one stem → chord. Duration comes from notehead type + flag/beam count + dots.
6. **Confidence:** combines the detector score, geometric ambiguity (a notehead halfway between a line and a space), and a **measure-sum check**: if a voice doesn't add up to the time signature, the measure is flagged and its least-confident events are marked `unresolved`.

The detector never sees the drum key. It finds "an x notehead at staff step 9", and the project's drum key decides that is a hi-hat. One model therefore works for any notation convention, and remapping in the app fixes the rest.

## Classes

[`classes.json`](classes.json) is the source of truth (29 classes). Each class lists its SMuFL glyph codes, which is how the generator labels symbols automatically.

| Group | Classes |
|---|---|
| Noteheads | `head_black`, `head_half`, `head_whole`, `head_x`, `head_circle_x`, `head_slash` |
| Rests | `rest_whole`, `rest_half`, `rest_quarter`, `rest_8th`, `rest_16th`, `rest_32nd` |
| Rhythm | `flag_8th`, `flag_16th`, `flag_32nd`, `beam`, `dot` |
| Header | `clef_percussion`, `timesig_0` … `timesig_9` |
| Articulation | `accent` |
| Later (P1) | `ghost_parens`, `open_o`, `flam_grace`, `roll_tremolo`, `sticking_R`, `sticking_L`, tempo marking |

Stems, barlines, staff lines and ledger lines are found with classic CV, not learned.

## Data

**Synthetic data is the main training source.** Every symbol position comes free, so there's no labeling cost.

1. **Groove sampler** (`generate/`): random but musical drum parts. Hat/ride ostinatos in quarters, 8ths or 16ths; kick and snare placed according to common-pattern priors; tom fills; rests; dotted values; accents. Mostly 4/4, with 3/4, 6/8 and 12/8. Output is MusicXML.
2. **Render with several engravers**, so the model doesn't overfit one look:
   - **Verovio** (`pip install verovio`) with the Leipzig, Bravura, Gootville, Petaluma and Leland fonts. Its SVG output tags each glyph by class, so bounding boxes come straight out of the SVG.
   - **The app's own VexFlow renderer**, driven headlessly with Playwright. `engrave()` already reports notehead coordinates.
   - **MuseScore 4 CLI** (`mscore -o page.svg in.musicxml`), for the most common real-world style.
   - Vary staff size, measures per system, stem lengths, beam thickness and page margins.
3. **Degrade the renders to look like real inputs** (albumentations):
   - downscale to 30–100% and back up
   - JPEG quality 20–90
   - blur
   - rotation of ±3° and mild perspective
   - noise and gamma changes
   - dark-mode inversion
   - coloured backgrounds
   - YouTube-style overlays: playback cursor bars, highlight boxes, watermarks, cropped edges
4. **Volume:** start with ~20k system crops and grow to ~100k if the real-data benchmark keeps improving.

**Real data is for evaluation, then fine-tuning.** Collect 50–100 screenshots and PDF pages from the sources you actually practise from. Label them in Label Studio or CVAT using the class list above. Put **30 of them in a frozen test set that is never trained on**, and use the rest to fine-tune once the synthetic model plateaus. These images are for personal training use only: don't commit them to the repo or redistribute them.

## Model

- **Detector (built):** torchvision **Faster R-CNN, ResNet-50 FPN** (BSD licence), COCO-pretrained. Its anchors are resized for small, elongated music symbols (`omr/common.py`). Inputs are normalized 256 px crops, enlarged 1.5x inside the model, and trained on random 768 px-wide windows. This was chosen over YOLOX/RT-DETR because torchvision ships it with ONNX export support and nothing extra to install. Avoid Ultralytics YOLO: it's AGPL, which would affect how the app can be distributed.
- **Training:** about 1.6 s per step of 4 images on an M1 Pro (Apple GPU), so roughly 7 hours for 3 epochs of 20k images. A 900-step proof run on 3k images reached synthetic-validation F1 0.99. The first version of the data never taught rare time-signature digits; the meter mix has since been rebalanced.
- **Export (built):** ONNX opset 17 via `export_onnx.py`, with a built-in PyTorch-vs-ONNX Runtime parity check (0.000 px difference on the proof model). The file is 166 MB; a MobileNet backbone or int8 quantization is the route to a smaller download.
- **Later, optional:** an image-to-token sequence model per system (TrOMR-style). It would serve as a second opinion: where it and the detector disagree, the measure is flagged. This improves flagging more than raw accuracy.

## Evaluation

Measure what the product needs, not only detector scores.

| Metric | What it tells you | MVP target |
|---|---|---|
| Detection mAP@0.5, per class | Is the detector learning each symbol? | ≥ 0.9 on the main classes |
| Event F1 (instrument + onset + duration all correct) | Are the notes right? | ≥ 0.9 on clean screenshots |
| **Measure exact-match rate** | Share of measures needing **zero** corrections | ≥ 80% clean, ≥ 60% low-res video grabs |
| **Flag recall** | Share of wrong measures that the app flagged | **≥ 95%**: errors must never be silent (FR-OCR-06) |
| Flag precision | Share of flagged measures that were actually wrong | ≥ 50%, so flags stay meaningful |

Flag recall matters more than accuracy: a confidently wrong score is the failure the PRD rules out.

Once recognition ships, corrections made in the app (recognized vs. corrected measure) are the best possible fine-tuning data. If collected, that should be opt-in and stay local, per the PRD's privacy rules.

## Layout

See the "What's where" section at the end of [GUIDE.md](GUIDE.md). Not built yet: MuseScore as a third engraver, and the Rust side (staff finding port, ONNX inference via `ort`, assembly into notes). `prepare_real.py` is the reference implementation for the Rust staff finder.
