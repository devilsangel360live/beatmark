//! Optical music recognition for drum notation.
//!
//! A replaceable pipeline, each stage feeding the next:
//!   1. preprocess  — grayscale, binarize, deskew
//!   2. staves      — find five-line staves and barlines (classic CV, no model)
//!   3. detect      — find symbols (noteheads, rests, flags, beams, dots, time sig) with an ONNX model
//!   4. assemble    — symbols → measures of timed events via the drum key and rhythm rules
//!   5. confidence  — per-event and per-measure scores; measures whose durations don't sum are flagged
//!
//! Output matches the frontend's `Measure` shape so it can be loaded straight into the editor.
//! Nothing is implemented yet; see training/README.md for the model plan.

use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedEvent {
    pub offset: u32,
    pub duration: String,
    pub dots: u8,
    pub instrument: Option<String>,
    pub confidence: f32,
    /// Set when the instrument or duration couldn't be decided (FR-OCR-06).
    pub unresolved: bool,
    /// Bounding box in source-image pixels, for linking notation back to the source.
    pub bbox: [f32; 4],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedMeasure {
    pub events: Vec<RecognizedEvent>,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recognition {
    pub time_signature: Option<(u32, u32)>,
    pub tempo: Option<u32>,
    pub measures: Vec<RecognizedMeasure>,
    /// Plain-language problems for the review screen (FR-OCR-06, NFR-07).
    pub warnings: Vec<String>,
}

pub fn recognize(_png: &Path) -> Result<Recognition, String> {
    Err("Recognition isn't built yet. You can enter the notes by hand next to the source image.".into())
}
