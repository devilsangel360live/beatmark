//! Running the trained symbol detector (models/drum-omr.onnx) and the rules applied to its output.

use std::path::Path;

use image::RgbImage;
use ort::environment::Environment;
use ort::session::builder::AutoDevicePolicy;
use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;

/// Detections below this are dropped. The frontend treats 0.3–0.5 as "probably, but check".
const MIN_SCORE: f32 = 0.3;
/// A filled notehead below this share of the staff's typical notehead height is a grace note.
const GRACE_RATIO: f32 = 0.85;

#[derive(Serialize, Clone, Debug)]
pub struct Detection {
    /// Class name from classes.txt, e.g. "head_x".
    pub class: String,
    pub score: f32,
    /// x0, y0, x1, y1 in the normalized staff crop.
    pub bbox: [f32; 4],
}

pub struct Detector {
    /// ONNX Runtime's environment; must outlive the session.
    _env: Environment,
    session: Session,
    /// Index 0 is "background".
    classes: Vec<String>,
}

impl Detector {
    pub fn load(model: &Path) -> Result<Self, String> {
        let classes_file = model.with_file_name("drum-omr.classes.txt");
        let classes = std::fs::read_to_string(&classes_file)
            .map_err(|e| format!("Could not read {}: {e}", classes_file.display()))?
            .lines()
            .map(str::to_owned)
            .collect();
        let load = || -> ort::Result<(Environment, Session)> {
            let env = ort::init().with_name("beatmark").build()?;
            // On macOS ort would otherwise pick Apple's CoreML accelerator, which can't run this
            // model: a pyramid level with zero candidate boxes is normal here, and CoreML rejects
            // zero-sized tensors. The CPU handles a page in a few seconds.
            let session = Session::builder(&env)?.with_auto_device(AutoDevicePolicy::PreferCPU)?.commit_from_file(model)?;
            Ok((env, session))
        };
        let (env, session) = load().map_err(|e| format!("Could not load the recognition model: {e}"))?;
        Ok(Self { _env: env, session, classes })
    }

    /// All symbols on one normalized staff crop, after the grace-note rule.
    pub fn detect(&mut self, crop: &RgbImage) -> Result<Vec<Detection>, String> {
        let (w, h) = crop.dimensions();
        // The model takes one RGB image as [3, height, width] floats in 0–1; it normalizes and resizes itself.
        let plane = (w * h) as usize;
        let mut data = vec![0f32; plane * 3];
        for (i, p) in crop.pixels().enumerate() {
            for c in 0..3 {
                data[c * plane + i] = p[c] as f32 / 255.0;
            }
        }
        let input = Tensor::from_array(([3usize, h as usize, w as usize], data)).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs!["image" => input]).map_err(|e| format!("Recognition failed: {e}"))?;
        let (_, boxes) = outputs["boxes"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let (_, labels) = outputs["labels"].try_extract_tensor::<i64>().map_err(|e| e.to_string())?;
        let (_, scores) = outputs["scores"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

        let detections = (0..scores.len())
            .filter(|&i| scores[i] >= MIN_SCORE)
            .map(|i| Detection {
                class: self.classes.get(labels[i] as usize).cloned().unwrap_or_else(|| "unknown".into()),
                score: scores[i],
                bbox: [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]],
            })
            .collect();
        Ok(resolve_grace_notes(detections))
    }
}

/// Same rule as training/omr/postprocess.py. The detector classifies every candidate at a fixed
/// 7x7 resolution, which hides the size difference between grace and normal noteheads; size
/// relative to the staff's other noteheads decides instead.
pub fn resolve_grace_notes(mut dets: Vec<Detection>) -> Vec<Detection> {
    let is_head = |d: &Detection| d.class == "head_black" || d.class == "grace_head";
    let mut heights: Vec<f32> = dets.iter().filter(|d| is_head(d)).map(|d| d.bbox[3] - d.bbox[1]).collect();
    if heights.len() < 2 {
        return dets;
    }
    heights.sort_by(f32::total_cmp);
    let full = quantile(&heights, 0.75);
    for d in dets.iter_mut().filter(|d| is_head(d)) {
        d.class = if d.bbox[3] - d.bbox[1] < GRACE_RATIO * full { "grace_head" } else { "head_black" }.into();
    }
    // The detector often proposed both classes for one notehead; after relabelling they collide.
    nms_per_class(dets, 0.5)
}

/// Linear interpolation between order statistics, like numpy/torch quantile.
fn quantile(sorted: &[f32], q: f32) -> f32 {
    let pos = q * (sorted.len() - 1) as f32;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f32)
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let iw = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let ih = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = iw * ih;
    let area = |r: &[f32; 4]| (r[2] - r[0]) * (r[3] - r[1]);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

fn nms_per_class(mut dets: Vec<Detection>, threshold: f32) -> Vec<Detection> {
    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in dets {
        if !kept.iter().any(|k| k.class == d.class && iou(&k.bbox, &d.bbox) > threshold) {
            kept.push(d);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(class: &str, score: f32, x: f32, h: f32) -> Detection {
        Detection { class: class.into(), score, bbox: [x, 100.0, x + h * 1.2, 100.0 + h] }
    }

    #[test]
    fn small_noteheads_become_grace_notes_and_duplicates_merge() {
        let dets = vec![
            det("head_black", 0.99, 0.0, 16.0),
            det("head_black", 0.99, 40.0, 16.0),
            det("head_black", 0.99, 80.0, 16.0),
            // A grace note the model called a normal notehead, and a normal one it called grace.
            det("head_black", 0.9, 120.0, 11.0),
            det("grace_head", 0.8, 160.0, 16.0),
            // The same small notehead proposed twice, once per class.
            det("grace_head", 0.95, 200.0, 11.0),
            det("head_black", 0.6, 200.5, 11.0),
        ];
        let out = resolve_grace_notes(dets);
        let class_at = |x: f32| out.iter().filter(|d| (d.bbox[0] - x).abs() < 1.0).map(|d| d.class.as_str()).collect::<Vec<_>>();
        assert_eq!(class_at(120.0), ["grace_head"]);
        assert_eq!(class_at(160.0), ["head_black"]);
        assert_eq!(class_at(200.0), ["grace_head"]);
        assert_eq!(out.len(), 6);
    }
}
