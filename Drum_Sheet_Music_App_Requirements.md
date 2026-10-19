# Drum Sheet Music Studio — Product Requirements Document

**Status:** Draft for vibe coding / MVP implementation  
**Working title:** Drum Sheet Music Studio  
**Product type:** Offline-first desktop app  
**Primary platform:** Desktop (Mac first; Windows/Linux desirable)  
**Audience:** One drummer learning drum parts from screenshots, PDFs, or existing notation  
**Notation reference:** Drumeo, “How To Read Drum Music (For Beginners),” updated August 14, 2026

## 1. Product vision

Build a drum-only notation and practice app with the feel of MuseScore 4, but focused on drum-set music. A user collects screenshots of drum sheet music from YouTube, Drumeo, or other sources, pastes them into Word, exports a PDF, imports that PDF (or the images directly), and gets an editable drum score. The user checks and corrects the transcription, then plays, pauses, stops, changes tempo, and loops a small passage while practicing.

The score is displayed as standard drum notation on a five-line percussion staff. It is not a step-sequencer or drum grid. The product should make scanned material editable, playable, and saveable as a real notation project.

## 2. Scope assumption

The phrase “5 bar drum sheet music/tabs” is interpreted as a **five-line drum staff**, not a fixed five-measure score. The score may contain any number of measures; the user controls zoom and measures per system. If the user intended exactly five measures visible at a time, that can be a layout preference later.

## 3. Problem and outcome

Screenshots and PDFs are convenient to collect but hard to edit, slow down, loop, or hear. General notation software can be powerful but carries complexity that a drummer does not need. This app should bridge those gaps with drum-specific score recognition and a notation-first editor.

**Success:** A user can bring in a short passage as a PDF or image, correct the recognized notes in a five-line drum score, hear the passage at a chosen tempo, loop a measure range, and save a project that reopens without losing notation or playback settings.

## 4. Product principles

1. **Notation first:** The score is the primary editing surface. No drum grid as the main or alternate editor in the MVP.
2. **Human review is expected:** OCR proposes notation; it must not imply certainty. Every recognized item can be corrected in place.
3. **Drum-specific, not general-purpose:** Focus the interface and features on drum-set scores and practice.
4. **Local-first:** Projects and source images remain on the user’s device. No account is needed for core use.
5. **Useful at small scope:** A short exercise or five-measure excerpt should be practical to import, fix, play, and loop.
6. **Interchangeable but loss-aware:** Preserve a native project format, and support MusicXML import/export for interchange where the format supports the feature.

## 5. Users and main workflow

### Primary user
A drummer learning lessons, exercises, or song parts from video and online sheet music, who wants a reliable way to transcribe, correct, and practice short sections.

### Main workflow

1. Create a project or import one or more score images / a PDF exported from Word.
2. Select pages or crop the relevant passage; rotate or adjust contrast if needed.
3. Run recognition and see the proposed score next to the source image.
4. Review uncertain measures or notes and correct them using score tools.
5. Play the score using a metronomic count-in and built-in drum sounds.
6. Select loop start/end measures, set a slower tempo, and repeat the passage.
7. Raise tempo manually or use gradual tempo steps.
8. Save the native project; optionally export MusicXML and a readable PDF.

## 6. MVP boundary

### P0 — required for first usable MVP

- Desktop app with a notation-first score editor.
- Import PDF and common image files (PNG, JPG/JPEG, TIFF); multi-page PDFs supported at least for selecting/importing a page.
- Display source image and recognized score together for side-by-side or overlay review.
- Recognition pipeline for basic drum-set notation, followed by manual correction.
- Five-line percussion staff, barlines, time signature, tempo marking, noteheads, rests, beams, and measure numbers.
- Core kit: bass drum, snare, hi-hat closed/open/pedal, rack tom(s), floor tom, crash cymbal, ride cymbal.
- Add, delete, move, and change a note; change instrument, rhythmic value, and articulation where supported.
- Playback with play, pause, stop, playback cursor, count-in, metronome, and audible kit sounds.
- Tempo control with numeric BPM entry and slider; tempo applies immediately without changing notation.
- Loop selected measure range; clearly show loop boundaries and repeat continuously until stopped or loop is disabled.
- Native project save/open, autosave or recovery, and export to MusicXML where supported.
- Undo/redo, zoom, and basic score layout controls.
- Clear warnings for unsupported or low-confidence recognition rather than silent omission.

### P1 — after core flow is proven

- MusicXML import and round-trip improvements for percussion notation.
- Export a clean PDF score.
- Sticking annotations (R/L), accents, ghost notes, flams, drags, rolls, ties, open/closed/loose hi-hat, dynamics, and rehearsal labels.
- Individual instrument mute/solo and limb groups (hands/feet).
- Tempo ramp practice (e.g., increase BPM by a selected amount every N successful or manually marked repetitions).
- Save loop ranges and practice tempo presets per project.
- Multiple score pages and continuous multi-system playback with repeat handling.
- MIDI export, subject to percussion mapping quality.

### Explicitly out of scope for MVP

- A drum grid, step sequencer, piano roll, or grid-based alternative editor.
- General melodic score editing, guitar tablature, DAW recording, or full audio production.
- Automatic recognition of every publisher’s notation style with no correction.
- Cloud accounts, collaboration, social features, or subscription content.
- Live drum-kit listening, performance grading, or automatic detection of clean repetitions.
- Video downloading or scraping from YouTube/Drumeo. The user supplies images/PDFs they are allowed to use.
- Full score road-map logic (D.S./D.C./coda, complex repeats, multiple endings) in MVP.

## 7. Functional requirements

### 7.1 Import and source handling

- **FR-IMP-01:** User can import a PDF, PNG, JPG/JPEG, or TIFF file through file picker and drag-and-drop.
- **FR-IMP-02:** PDF import preserves page order and lets user choose one or more pages for recognition.
- **FR-IMP-03:** User can crop to the relevant score region, rotate the image, and adjust brightness/contrast before recognition.
- **FR-IMP-04:** App retains the original source image/PDF page in the project so the user can compare the transcription against it.
- **FR-IMP-05:** App must not alter the original source file.
- **FR-IMP-06:** Import screen explains that screenshot quality, skew, compression, overlapping annotations, and unfamiliar notation can reduce recognition accuracy.

### 7.2 Recognition and review

- **FR-OCR-01:** Recognition identifies score structure where possible: staff lines, percussion clef, barlines, time signature, tempo marking, notes/rests, notehead types, stems, beams, and common drum-instrument positions.
- **FR-OCR-02:** Recognition outputs an editable notation model, not a flattened image.
- **FR-OCR-03:** Each recognized item or measure can carry an internal confidence value. Low-confidence regions are visibly flagged for review.
- **FR-OCR-04:** User can compare source and notation side-by-side, with linked navigation by measure/region.
- **FR-OCR-05:** User can correct errors using the notation editor; correction must not require re-running recognition for the whole page.
- **FR-OCR-06:** When the system cannot distinguish an instrument or rhythmic value, it asks the user to choose or leaves a visible unresolved marker. It must not silently guess.
- **FR-OCR-07:** Initial recognition supports common standard drum notation only. Alternate layouts should remain editable through user remapping.

### 7.3 Score editor and notation

- **FR-ED-01:** The primary score uses a five-line percussion staff and standard barlines; the editor supports multiple systems and pages.
- **FR-ED-02:** Staff position maps to drum instruments using a visible drum key. The app must allow changing instrument mapping because conventions vary.
- **FR-ED-03:** Cymbal and hi-hat notes can use x-shaped noteheads; drum hits use round noteheads, consistent with the selected notation style.
- **FR-ED-04:** User can add, select, move, delete, and change the instrument of individual notes.
- **FR-ED-05:** User can set note values and rests for at minimum whole, half, quarter, eighth, and sixteenth durations; dotted values should be supported if the notation engine allows within MVP.
- **FR-ED-06:** Simultaneous hits on different kit pieces can be entered at the same rhythmic position and visually aligned.
- **FR-ED-07:** Support basic time signatures and measures that validate rhythmic duration. Default new project is 4/4; user may change it.
- **FR-ED-08:** User can change tempo marking and time signature from score properties.
- **FR-ED-09:** Note entry should be possible by clicking a rhythmic position on the staff, using keyboard shortcuts, or choosing a note value and then clicking staff position.
- **FR-ED-10:** Undo and redo cover note edits and score property edits.
- **FR-ED-11:** Measures can reflow into systems when zoom or page width changes, without changing musical timing.
- **FR-ED-12:** Show measure numbers; allow the user to set a measure as the start of numbering if the excerpt begins mid-song.

### 7.4 Playback and practice

- **FR-PLAY-01:** Play, pause, stop, and restart are always available from a persistent transport area and keyboard shortcuts.
- **FR-PLAY-02:** A moving cursor highlights the current beat/position in the score. Playback must remain synchronized with the score when zoom or layout changes.
- **FR-PLAY-03:** Built-in drum sounds play each recognized instrument. Users can choose a basic sound set; sound realism is secondary to clear timing and distinct instruments.
- **FR-PLAY-04:** User can set BPM numerically and with a slider. Display current BPM clearly.
- **FR-PLAY-05:** Tempo changes affect playback only and do not rewrite note spacing or durations.
- **FR-PLAY-06:** Provide an audible count-in (default one measure) and optional metronome click.
- **FR-PLAY-07:** User can set loop start and end by selecting measures; the selected range is visibly shaded or bracketed.
- **FR-PLAY-08:** Loop repeats seamlessly without a gap beyond the musical duration, and stops promptly when Stop is pressed.
- **FR-PLAY-09:** User can play the entire score or the active loop range.
- **FR-PLAY-10:** Playback timing is derived from the editable musical event model; source image is never used as playback data.

### 7.5 Save, export, and recovery

- **FR-FILE-01:** Native project format stores score events, layout, instrument map, tempo/time signature, source image references, loop selection, and user playback settings.
- **FR-FILE-02:** Native project opens with no network connection and retains the last saved state.
- **FR-FILE-03:** App autosaves or provides recoverable drafts after an unexpected close.
- **FR-FILE-04:** MusicXML export is available for supported notes and markings. If an element cannot be represented faithfully, show an export warning and preserve it in the native project.
- **FR-FILE-05:** MusicXML import is desirable in MVP if feasible, but is not a substitute for the PDF/image recognition workflow.
- **FR-FILE-06:** Export a PDF score as a P1 item; exported PDF should show the percussion staff, time signature, tempo, instrument key, measure numbers, and notes clearly.
- **FR-FILE-07:** Saving never overwrites the imported source PDF/image.

## 8. Notation rules and source of truth

Drumeo’s guide is the starting reference, not a claim that all drum notation is standardized. It explicitly notes that notation varies between books and lessons. Therefore:

- Start with a standard five-line percussion staff and a configurable drum key.
- Support traditional and modern stem conventions as a display preference if practical; MVP may select one consistent style.
- Use x noteheads for cymbals/hi-hat and round noteheads for drums by default.
- Map low staff positions to bass drum/floor tom, middle positions to snare/toms, and high positions to cymbals, while allowing remapping.
- Represent time signature and tempo visibly at the beginning of the score.
- Account for note duration using note values, rests, beams, dots, and ties when supported.
- Defer advanced notation symbols unless listed as P1.

Reference: Drumeo, “How To Read Drum Music (For Beginners),” sections on staff, time signature/tempo, noteheads, note values, rests, stems, sticking, accents, hi-hat articulations, grace notes, rolls, dynamics, and directions. Updated Aug. 14, 2026. https://www.drumeo.com/beat/how-to-read-drum-music/

## 9. User interface outline

### Main workspace

- **Top toolbar:** Open/import, save, undo/redo, score properties, export.
- **Center:** notation score, using a five-line percussion staff; selectable notes and measures; playhead and loop shading.
- **Source panel:** imported page/image, synchronized to score location; collapsible to maximize score.
- **Bottom transport:** Play/Pause/Stop, count-in, metronome, tempo, loop controls, current measure/beat.
- **Properties panel:** selected note’s instrument, rhythmic value, articulation, and any supported accent/sticking controls.

### Import review screen

- Source image or PDF page on one side.
- Recognized score on the other side.
- Confidence/attention markers on uncertain notes or measures.
- “Open in editor” action after recognition; original source remains available.

### Editing behavior

- Clicking a note selects it and opens relevant properties.
- A selected rhythmic value plus staff click inserts a note at that position.
- Modifier or context menu changes an instrument without moving timing.
- Keyboard shortcuts for play/pause, stop, undo/redo, note duration selection, and delete.
- Avoid modal dialogs for frequent note edits.

## 10. Technical direction for vibe coding

This is implementation guidance, not a requirement to lock the exact libraries before a prototype.

### Recommended architecture

- **Desktop shell:** Tauri or Electron, chosen based on ecosystem support for audio timing and local file access.
- **UI:** React + TypeScript for the score workspace and editing interactions.
- **Notation rendering:** Use a proven music engraving/rendering library where possible; do not hand-draw every symbol in the first prototype. Confirm percussion support before choosing.
- **Canonical model:** A native JSON project model with stable IDs and explicit rhythmic positions. MusicXML is an import/export interchange format, not the only source of truth.
- **Recognition:** Treat optical music recognition as a replaceable pipeline: image cleanup → staff detection → symbol/note recognition → drum mapping → confidence review → editable score model. Start with a small supported notation set and always expose correction.
- **Audio:** Use an audio scheduler that can schedule events against a monotonic clock and reschedule safely on tempo changes. Avoid timer-per-note playback because it drifts.
- **Persistence:** Local project files plus autosave/recovery. Bundle built-in drum samples with clear licensing.

### Suggested native project shape

A project should contain:

- `schemaVersion`
- `metadata` (title, source attribution notes, created/modified timestamps)
- `score` (time signatures, tempo marks, measures, events)
- `instrumentMap` (staff position / pitch / instrument / notehead mapping)
- `layout` (system breaks, zoom, notation style)
- `practice` (loop boundaries, playback tempo, count-in, metronome, mute/solo state)
- `sources` (embedded or packaged source images/PDF pages and crop transforms)

The project should be a single portable file/package rather than an opaque database dependency. Exact extension and container format can be chosen during prototyping.

## 11. Non-functional requirements

- **NFR-01 Reliability:** No data loss during normal editing; autosave/recovery must be tested.
- **NFR-02 Responsiveness:** Score editing should feel immediate for short and medium drum excerpts; import processing may take longer but must show progress.
- **NFR-03 Playback:** No audible timing drift during a several-minute score; pause/resume and stop should respond predictably.
- **NFR-04 Local privacy:** Imported source content and projects stay local by default. If recognition uses a cloud service, it must be opt-in and clearly disclosed; local recognition is preferred.
- **NFR-05 Accessibility:** Keyboard operation for core transport and editing; sufficient contrast for confidence and loop markers; do not rely on color alone.
- **NFR-06 Cross-platform:** Keep the project format portable. macOS is the first target; Windows/Linux compatibility is a design goal.
- **NFR-07 Error handling:** Unsupported notation, unreadable scans, and export loss are reported in user language with a recovery action.
- **NFR-08 Performance:** Opening, saving, and editing a short excerpt should not require a network connection or user account.

## 12. Acceptance criteria for the first end-to-end prototype

A prototype is ready for user testing when all are true:

1. User can import a cropped page from a PDF or a PNG screenshot.
2. App creates a multi-measure editable five-line drum score from a supported sample, with uncertain items flagged.
3. User can correct at least instrument, rhythmic position, and note value for a recognized hit.
4. User can add and delete notes using the score staff.
5. User can play, pause, stop, and hear distinct kick, snare, hi-hat, and cymbal sounds.
6. User can set BPM, select a measure range, and loop it continuously.
7. User can save, close, reopen, and retain the score, source page, and loop selection.
8. MusicXML export produces a valid file for the supported subset and reports any limitations.
9. Import failure or low confidence is visible; it does not silently create an apparently complete but incorrect score.

## 13. Risks and product decisions to validate

- **Recognition is the largest technical risk.** Drum OMR from screenshots can be difficult because of low resolution, skew, compression, handwritten markings, and differing drum keys. A usable MVP should constrain supported input styles and emphasize correction.
- **Notation interchange is imperfect.** MusicXML can carry much standard notation, but drum-set naming, noteheads, articulations, and layout may not round-trip consistently across software. Keep a native model and test with real files from MuseScore and other tools.
- **Input rights and site terms vary.** The app should process user-provided files without scraping or downloading content from lesson sites; users remain responsible for having rights to import and export their source material.
- **Interpretation of “5 bar.”** Confirm later whether this means five staff lines (assumed here) or a preference to show exactly five measures in each visible system.
- **First prototype should test the whole loop.** Prioritize one clear path: PDF/image → editable short score → playback → loop/tempo → save. A broad feature set without reliable transcription correction will not solve the core problem.

## 14. Suggested build sequence

1. **Notation canvas prototype:** Manually create a short drum score on a five-line staff; verify note entry, editing, and readable rendering.
2. **Playback prototype:** Play that score with tempo, count-in, stop/pause, and measure looping.
3. **Project persistence:** Save and reopen a native project without losing events or loop settings.
4. **Recognition spike:** Import a small set of representative screenshots/PDF pages; measure what can be recognized reliably and identify unsupported symbols.
5. **Human correction workflow:** Connect recognition output to editable notes with confidence flags.
6. **MusicXML interoperability:** Add import/export for the subset, then test round trips with actual MuseScore files.
7. **Polish:** PDF export, keyboard shortcuts, additional articulations, and supported platform packaging.

## 15. Initial product decisions

| Decision | Initial choice | Reason |
|---|---|---|
| Primary editing view | Five-line drum staff | User wants proper sheet music and a MuseScore-like experience |
| Drum grid | Excluded | Not the intended notation or editing model |
| Recognition | Assisted, confidence-aware | Image recognition errors must remain easy to inspect and correct |
| Project format | Native portable project + MusicXML interchange | Preserve app-specific source and practice data while enabling score exchange |
| Practice features | Play/pause/stop, BPM, count-in, metronome, selected-measure loop | Directly supports learning short passages |
| First target | Desktop, local-first | Matches Word/PDF/image workflow and avoids account/network dependency |
| “5 bar” interpretation | Five-line staff, flexible measures per system | Most likely intended meaning in the drum notation context |

## 16. Future brainstorming candidates (not commitments)

After the first prototype works, consider: tempo ladders; hands/feet or instrument isolation; saved loop presets; practice notes; measure-by-measure confidence and correction history; compare original score crop with edited notation; sound customization; sticking and rudiment tools; PDF page templates for print; MIDI export; import from MusicXML; and optional smart practice reminders. Validate these against actual use before expanding scope.
