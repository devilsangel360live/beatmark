# Training the drum-symbol model: a beginner's guide

This guide assumes no machine-learning background. Every command has been run on an M1 Pro MacBook. Run commands from the `training/` folder unless a step says otherwise:

```sh
cd ~/Projects/Beatmark/training
```

---

## Part 1 — What we're actually doing (5-minute read)

### The job
Beatmark has to look at a picture of drum music and work out the notes. We split that into two parts:

1. **Find the symbols** (this guide). Given a picture of one staff, draw a box around every music symbol and name it, e.g. "x-notehead here", "eighth rest here", "beam here". This is the part a computer has to *learn*.
2. **Turn the symbols into notes** (later, in the app's Rust code). An x-notehead on the top space is a hi-hat; a notehead with one beam is an eighth note; and so on. This part is plain rules, not learning.

### Words you'll see

| Word | Meaning |
|---|---|
| **Model** | A program with millions of adjustable numbers inside. Before training it knows nothing about music; training adjusts the numbers until its answers are right. Ours is called *Faster R-CNN*, a standard "object detector". |
| **Object detection** | The task of drawing boxes around things in an image and naming each one. The same technique finds pedestrians in car cameras; we use it for noteheads. |
| **Class** | One kind of thing the model can name. We have 35 classes: `head_x`, `rest_8th`, `beam` and so on. The full list is in `classes.json`. The model can only ever answer with one of these names. |
| **Label** | The correct answer for one training image: a box plus a class name for every symbol. The model learns by comparing its guesses with labels, millions of times. |
| **Labeling** | Drawing those correct boxes. By hand it's slow: about 60 boxes per staff. |
| **Synthetic data** | Training images we *generate* instead of collecting. We write random drum grooves, have music software draw them, and because we drew them, we know exactly where every symbol is. **Labels come free.** |
| **Training** | Showing the model labelled images over and over, nudging its numbers each time it's wrong. |
| **Step** | One nudge, made after looking at a small batch of images (4 by default). |
| **Epoch** | One pass through every training image. |
| **Validation set** | 5% of the images held back and never trained on. We test on them to check the model learned the skill instead of memorising the training pictures. |
| **Precision / recall / F1** | Scores from 0 to 1. *Precision*: when it says "notehead", how often is it right? *Recall*: of all the real noteheads, how many did it find? *F1* combines the two. 1.0 is perfect. |
| **Checkpoint** | A saved copy of the model's numbers (`.pt` file), so you can stop and resume or use it later. |
| **ONNX** | A standard file format for trained models. The desktop app loads the `.onnx` file to run the model without Python. |

### Why each image is "one staff, 16 px between lines"
Screenshots come in every size. Before the model sees anything, we cut out one staff and scale it so its five lines are exactly **16 pixels apart**. Every notehead then appears at roughly the same size, which makes learning much easier. The generator produces images in this format, and `prepare_real.py` converts your real screenshots to it.

### Do I need to label anything?
**Not to get started.** The synthetic data is fully labelled automatically. A first model trained only on synthetic data already reads clean drum notation well.

**Later, a little.** To find out how well the model handles *your* real screenshots, and to fix the mistakes it makes on them, you'll label about 30–60 real staves (Part 3). That takes an afternoon, and the model can draw first guesses for you to correct.

---

## Part 2 — Train your first model (about 8 hours, mostly unattended)

### Step 0 · One-time setup (10 minutes)

You already have Node, `uv` (a Python tool) and Google Chrome. Install the Python packages:

```sh
cd ~/Projects/Beatmark/training
uv sync
```

This downloads PyTorch and friends (~1 GB) into `training/.venv`. Check it worked:

```sh
uv run python -c "import torch; print('Apple GPU available:', torch.backends.mps.is_available())"
```

You should see `Apple GPU available: True`.

The generator also needs the app's Node packages, which you installed for the app (`npm install` in the project root). Nothing extra is needed.

### Step 1 · Generate synthetic training data (≈15 minutes)

```sh
node synth/generate.mjs --count 20000 --out data/synth --workers 4
```

What happens: headless Chrome opens a hidden page that invents a random drum groove and draws it with one of two music engravers (VexFlow or Verovio) in one of several music fonts. It reads the exact position of every symbol from the drawing, saves a screenshot, and repeats this 20,000 times. Progress prints every 100 images (expect ~30 images/second).

You get:
```
data/synth/train/images/0000001.png …   ~19,000 images
data/synth/train/labels.jsonl           the boxes for every training image
data/synth/val/images/…                 ~1,000 held-back images
data/synth/val/labels.jsonl
```

Each line of `labels.jsonl` describes one image, for example:
```json
{"image": "images/0000042.png", "width": 1066, "height": 256, "boxes": [[3, 120.5, 61.2, 136.1, 77.0], …]}
```
Each box is `[class number, left, top, right, bottom]`. Class number 3 is the 4th entry in `classes.json`, which is `head_x`.

> Re-running with the same `--count` and `--seed` reproduces identical images. Add `--clean` to delete an old folder first.

### Step 2 · Look at your data (2 minutes; please don't skip)

```sh
uv run show_labels.py data/synth/train --count 20
open data/synth/train/preview
```

Each preview shows an image with its boxes drawn on and named. Check that boxes hug their symbols. Bad labels make a bad model, and this is the cheapest place to catch them.

To see the random damage applied during training (blur, JPEG artifacts, tilt, colour shifts, fake playback cursors):

```sh
uv run show_labels.py data/synth/train --count 20 --augment
```

### Step 3 · Train (≈7 hours on an M1 Pro)

Plug in the charger. `caffeinate -i` stops the Mac from sleeping while the command runs:

```sh
caffeinate -i uv run train.py --data data/synth --name first-run --epochs 3
```

What you'll see:
```
Device: mps. Saving to …/runs/first-run
19004 training images, 996 validation images
epoch 1/3:  12%|█▏   | 560/4751 [15:10<1:53:30, 1.62s/it, loss=0.412, lr=0.0100]
```
- **`loss`** is how wrong the model currently is. It starts around 3–5 and should fall below 0.5 within the first hour. It bounces around; only the trend matters.
- **`1.62s/it`** means seconds per step. The bar shows the time remaining for this epoch.

At the end of each epoch it scores the validation images and prints a table like this:
```
class             count  precision   recall     F1
head_black         1780      0.996    0.998  0.997
head_x             2200      1.000    0.996  0.998
beam               1527      0.976    0.988  0.982
…
ALL                8123      0.992    0.987  0.990
epoch 1: validation F1 0.990
  new best → runs/first-run/best.pt
```

**`runs/first-run/best.pt` is your trained model.**

For reference, a 27-minute test run (3,000 images, 900 steps) already reached F1 0.99 overall on validation images. The full run is mainly about robustness on messy real screenshots.

**Stopping and resuming:** press `Ctrl+C` at any time. `last.pt` is saved after every epoch. Continue with:
```sh
caffeinate -i uv run train.py --data data/synth --name first-run --epochs 3 --resume runs/first-run/last.pt
```

**Want it faster?** Training on a rented NVIDIA GPU is roughly 5–10× faster; the same commands work there, and `--device cuda` is picked automatically. Not needed to get started.

### Step 4 · Check the result

Score it on the held-back synthetic images:
```sh
uv run evaluate.py runs/first-run/best.pt data/synth/val
```

See what it finds on any images; boxes are drawn with confidence scores:
```sh
uv run predict.py runs/first-run/best.pt data/synth/val/images --out predictions/synth
open predictions/synth
```

### Step 5 · Try it on your real screenshots (no labeling needed)

Put a few screenshots or PDFs of drum music you practice from in a folder, e.g. `~/Desktop/drum-screens/`. Then:

```sh
uv run prepare_real.py ~/Desktop/drum-screens/* --out data/real/crops
open data/real/crops/debug        # green boxes = staves it found. Any missing?
uv run predict.py runs/first-run/best.pt data/real/crops --out predictions/real
open predictions/real
```

`prepare_real.py` straightens tilted images, finds every staff, and crops and scales each one to the 16 px format. Then `predict.py` draws what the model sees.

**This is the most informative step.** Make a note of what goes wrong: missed symbols, wrong names, symbols your sources use that aren't in our class list. That tells you what to fix next.

---

## Part 3 — Make it good on *your* material

Synthetic data can't capture everything about real screenshots: different engraving software, watermarks, odd fonts. The fix is a small amount of real labelled data.

### Step 6 · Label real staves in Label Studio (an afternoon)

Label Studio is a free labelling app that runs in your browser.

1. **Install and start it** (in a separate terminal, leave it running):
   ```sh
   uv tool install label-studio
   label-studio start
   ```
   It opens http://localhost:8080. Create an account; it stays on your computer.
2. **Create a project:** *Create Project*, name it "Beatmark symbols", then open the *Labeling Setup* tab and choose *Custom template*. Delete what's in the code box and paste the output of:
   ```sh
   uv run labelstudio.py config
   ```
   Click *Save*.
3. **Pick images:** choose **60 crops** from `data/real/crops/` that represent your sources. Drag them into the project's *Data Import* page.
   - *Optional time-saver:* let the model draw first guesses so you only fix mistakes. This needs Label Studio's local-file access; the commands are in **Appendix A**.
4. **Label:** open each image. For every symbol, click the class name in the list above the image (or press its hotkey if one is shown next to it), then drag a box around the symbol.
   - Box **only the ink** of the symbol, tightly.
   - Box each beam line separately: a 16th-note group has two beams.
   - **Don't** box stems, barlines, staff lines, text, sticking letters or the tempo mark.
   - Zoom with the scroll wheel; `Ctrl+Z` undoes.
   - Click *Submit* when an image is done.

   Expect 3–5 minutes per staff.
5. **Export:** in the project, click *Export*, choose **YOLO**, and unzip the download, e.g. to `~/Downloads/ls-export/`.
6. **Convert to our format.** Hold some images back for testing: the first export becomes your *test set*, which you never train on. Label the remaining images later and export them separately as your *train set*.
   ```sh
   uv run labelstudio.py import ~/Downloads/ls-export data/real/test
   ```

### Step 7 · Measure on real data

```sh
uv run evaluate.py runs/first-run/best.pt data/real/test
```

This is the honest score. Synthetic scores are always optimistic. Watch **recall** in particular: a symbol the model misses is a note the app silently drops. Product targets are in `README.md`.

### Step 8 · Fine-tune with your real labels

Once you have ~30+ labelled real staves in `data/real/train` (not the test ones), continue training from your model. The real images are repeated so they carry weight against the 19k synthetic ones:

```sh
caffeinate -i uv run train.py --data data/synth --name finetune-1 \
  --init runs/first-run/best.pt --extra data/real/train --lr 0.003 --epochs 1
uv run evaluate.py runs/finetune-1/best.pt data/real/test
```

If the real-test score went up, use the new model. Repeat as you label more.

### Step 9 · Export for the app

```sh
uv run export_onnx.py runs/finetune-1/best.pt --sample data/real/crops/<any-crop>.png
```

This writes `src-tauri/models/drum-omr.onnx` (~166 MB) and checks that it gives the same answers as the PyTorch model. You should see `Largest box difference: 0.000 px — OK`. The app's Rust side will load this file. (It's excluded from git because of its size.)

---

## Part 4 — Changing things

| You want to… | Do this |
|---|---|
| Add a symbol type | Append a class to the **end** of `classes.json` (never reorder: the position is the id) with its SMuFL code, make `synth/grooves.ts` sometimes produce it, and regenerate the data. Then fine-tune from your last model with `--init`: the existing classes keep what they learned and only the new ones start from scratch. |
| Make grooves more like your material | Edit the probabilities in `synth/grooves.ts`. For example, `fillChance` controls tom fills, and `TIME_SIGNATURES` controls meter frequencies. |
| More variety | Generate more images (`--count 50000`), or add engravers/fonts in `generate.mjs`. |
| Smaller/faster model for the app | Later: swap the backbone in `omr/common.py` (e.g. MobileNet) and retrain, or quantize the ONNX file. |

## Troubleshooting

| Problem | Fix |
|---|---|
| `Executable doesn't exist … chromium` | The generator uses your installed Google Chrome; make sure it's installed in /Applications. |
| `Loss became nan` | Lower the learning rate: add `--lr 0.005`. |
| Out of memory / Mac very sluggish | `--batch 2 --workers 2`. |
| Training seems stuck at the first step | The first steps take ~40 s while the GPU warms up; that's normal. |
| `prepare_real.py` finds no staves | Open the image: are the staff lines visible? Very small screenshots (lines < 4 px apart) can't be read. Use a bigger screenshot. |
| Predictions look shifted or the wrong size | The input wasn't a normalized crop. Always run `prepare_real.py` first. |

## Appendix A · Pre-labeling with the model

Instead of drawing every box, let the model draw its guesses and only fix mistakes.

```sh
# 1. Start Label Studio with permission to read files in your home folder
LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED=true LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT=$HOME label-studio start
```
2. In your project, go to *Settings*, then *Cloud Storage*, then *Add Source Storage*, and choose **Local files**. Set the absolute path to your crops folder, e.g. `/Users/you/Projects/Beatmark/training/data/real/crops`. If there's an option like "Treat every bucket object as a source file", turn it on. Click *Add*, and **don't** click Sync, because the next step imports the files with the model's boxes attached.
3. Create the task file and import it on the *Data Import* page:
   ```sh
   uv run labelstudio.py prelabel runs/first-run/best.pt data/real/crops
   # → data/real/prelabel-tasks.json
   ```
4. Each image opens with boxes already drawn. Fix wrong ones, delete extras, add missing ones, and click *Submit*.

## What's where

```
training/
  GUIDE.md           this file
  README.md          design notes and accuracy targets
  classes.json       the 35 symbol classes (shared by generator and trainer)
  pyproject.toml     Python dependencies (uv sync)
  synth/             synthetic data generator (runs in headless Chrome)
    grooves.ts         random drum grooves
    page.ts            draws a groove, reads off symbol boxes
    generate.mjs       the command you run
  omr/               shared Python code: model, dataset + augmentation, scoring
  show_labels.py     draw labels on images
  train.py           train / resume / fine-tune
  evaluate.py        score a model on labelled images
  predict.py         draw a model's predictions
  prepare_real.py    screenshots/PDFs → normalized staff crops
  labelstudio.py     Label Studio config, pre-labeling, import
  export_onnx.py     checkpoint → src-tauri/models/drum-omr.onnx
  data/, runs/       generated data and trained models (not in git)
```
