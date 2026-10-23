//! Optical music recognition for drum notation: the image half of the pipeline.
//!
//!   1. preprocess  — grayscale, deskew                                   (staff.rs)
//!   2. staves      — find five-line staves; crop each to 16 px spacing   (staff.rs)
//!   3. detect      — symbols with the ONNX model, then relabel filled noteheads by size:
//!                    below 85% of the staff's typical notehead height is a grace note
//!                    (detect.rs; same rule as training/omr/postprocess.py)
//!   4. barlines    — vertical strokes spanning exactly the staff height  (staff.rs)
//!
//! Turning symbols into timed notes happens in the frontend (src/omr/assemble.ts), next to the
//! score model it produces.

pub mod detect;
pub mod staff;

use std::path::Path;

use serde::Serialize;

pub use detect::{Detection, Detector};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedStaff {
    /// Region of the source image this staff came from (x0, y0, x1, y1), for linking back to it.
    pub page_box: [f32; 4],
    pub crop_width: u32,
    pub crop_height: u32,
    /// Y of the top and bottom staff lines in the normalized crop (about 96 and 160).
    pub top_line: f32,
    pub bottom_line: f32,
    /// X of each barline in the normalized crop, left to right.
    pub barlines: Vec<f32>,
    pub symbols: Vec<Detection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recognition {
    pub staves: Vec<RecognizedStaff>,
    /// Degrees the page was rotated to straighten it.
    pub deskew: f32,
    /// Plain-language problems for the review screen (FR-OCR-06, NFR-07).
    pub warnings: Vec<String>,
}

/// Find every staff on a page image and the symbols on it.
pub fn recognize(image: &Path, detector: &mut Detector) -> Result<Recognition, String> {
    let gray = image::open(image).map_err(|e| format!("Could not open the source image: {e}"))?.to_luma8();
    let (gray, deskew) = staff::deskew(&gray);
    let staves = staff::find_staves(&gray);
    let mut warnings = Vec::new();
    if staves.is_empty() {
        warnings.push(
            "No staff lines were found on this page. Use a sharper or larger screenshot of standard five-line drum notation."
                .into(),
        );
    }
    let mut out = Vec::new();
    for s in &staves {
        if s.space < 4.0 {
            warnings.push("A staff is too small to read reliably (its lines are under 4 px apart). Use a larger screenshot.".into());
            continue;
        }
        let crop = staff::crop_staff(&gray, s);
        let symbols = detector.detect(&crop.image)?;
        out.push(RecognizedStaff {
            page_box: crop.page_box,
            crop_width: crop.image.width(),
            crop_height: crop.image.height(),
            top_line: crop.top_line,
            bottom_line: crop.bottom_line,
            barlines: staff::find_barlines(&crop.image, crop.top_line, crop.bottom_line),
            symbols,
        });
    }
    Ok(Recognition { staves: out, deskew, warnings })
}
