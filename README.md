# Beatmark

Offline desktop app for turning drum sheet music (screenshots, PDFs) into an editable, playable five-line drum score. See [Drum_Sheet_Music_App_Requirements.md](Drum_Sheet_Music_App_Requirements.md) for the PRD.

## Run

Requires Node 20+, Rust 1.85+, and on macOS the Xcode command-line tools.

```sh
npm install
npm run tauri dev      # desktop app
npm run dev            # UI only, in a browser at http://localhost:1420 (no file access)
```

### Recognition model

Reading sheet music needs the trained model at `src-tauri/models/drum-omr.onnx` (plus `drum-omr.classes.txt`). It's too large for git, so produce it with `training/export_onnx.py` (see `training/GUIDE.md`) or copy it in. The app is bundled with it, so builds fail without it.

In the app: **Import image or PDF** (each PDF page becomes a source page), then **Recognize notation**. Every page is read in order and replaces the score as one undoable step. Measures that don't add up, weak detections and notes that match no drum in the drum key are marked for review. Selecting a recognized measure highlights where it came from on the source page.

How it works: `src-tauri/src/omr/` finds staves and barlines and runs the detector (Rust, ONNX Runtime on the CPU); `src/omr/assemble.ts` turns the symbols into timed notes. The app targets macOS 13.4+, a requirement of ONNX Runtime's prebuilt library.

## Test

```sh
npm test               # model, scheduler, MusicXML (Vitest)
npm run test:rust      # project package I/O (cargo test)
npm run typecheck
```

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | Score model: tick-based timing, drum key, edit commands, validation. Pure TS, no UI. |
| `src/playback/` | `scheduler.ts` (pure lookahead scheduler, unit-tested), `engine.ts` (Web Audio binding), `drumSounds.ts` (placeholder synthesized kit) |
| `src/render/engrave.ts` | Score model → VexFlow SVG, plus geometry for hit-testing and the playhead |
| `src/io/` | MusicXML export, typed wrappers for Rust commands |
| `src/store/editor.ts` | Zustand store; undo/redo from Immer patches |
| `src/ui/` | React components and shared actions (toolbar, keyboard and buttons call the same code) |
| `src-tauri/src/package.rs` | `.beatmark` package = zip of `project.json` + `sources/*.png`, written atomically |
| `src-tauri/src/sources.rs` | Image import; everything is normalized to PNG (WebView2 can't show TIFF) |
| `src-tauri/src/omr/` | Recognition pipeline boundary (not implemented yet) |
| `training/` | Plan for the notation recognition model |

## Model conventions

- Time is integer ticks, 480 per quarter note. Events store an offset within their measure. Seconds exist only in playback.
- Hands are written stems-up (voice 1), feet stems-down (voice 2). A chord is the events in one voice at one offset; they share a duration.
- Rests are derived at render/export time, never stored.
- Triplets and sextuplets are a `tuplet` on the duration and play at 2/3 of the written value (a triplet eighth is 160 ticks). They're drawn with their number only when a complete group fills its span.
- A tie (`tie: true`) joins a note to the next note of the same drum, even across a barline; the second note sustains instead of being struck. Flams and drags are articulations, played as quiet grace hits just before the note.
- The drum key (`instrumentMap`) is per project. The default follows Drumeo's conventions.
- Edits to score, drum key and title go through `useEditor().edit(label, recipe)` and are undoable. Practice settings (tempo, loop, count-in) and view settings (zoom, bars per line) are saved but not undoable.

## Keyboard

| Key | Action |
|---|---|
| Space / Esc / Home | Play-pause / stop (or leave note input) / restart |
| N | Toggle note input; click the staff to add a note |
| 3–8, `.` | 32nd … whole, toggle dot (MuseScore layout) |
| C H O R T M S F K P | Change selected notes to that drum (see Drum key panel) |
| ←/→, ↑/↓ | Move selected notes in time / to the next drum up or down |
| A / G | Accent / ghost |
| L | Toggle loop (selects the current measure selection if no loop yet) |
| ⌘Z / ⌘⇧Z, ⌘S, ⌘O | Undo / redo, save, open |
