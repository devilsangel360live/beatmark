//! Finding staves on a page and cutting them out in the detector's input format.
//! A port of training/prepare_real.py; keep the two in step.

use image::imageops::{self, FilterType};
use image::{GrayImage, Luma, RgbImage};

/// Pixels between staff lines in every crop the detector sees (training/classes.json).
pub const STAFF_SPACE: f32 = 16.0;
const SPACES_ABOVE: f32 = 6.0;
const SPACES_BELOW: f32 = 6.0;

#[derive(Debug, Clone)]
pub struct Staff {
    /// Y of the top and bottom staff lines on the (deskewed) page.
    pub top: f32,
    pub bottom: f32,
    pub space: f32,
    pub left: u32,
    pub right: u32,
}

pub struct StaffCrop {
    pub image: RgbImage,
    /// Region of the (deskewed) page the crop came from: x0, y0, x1, y1.
    pub page_box: [f32; 4],
    /// Y of the top and bottom staff lines inside the crop.
    pub top_line: f32,
    pub bottom_line: f32,
}

/// Straighten a slightly rotated page: pick the angle (±3°) at which ink rows are sharpest.
pub fn deskew(gray: &GrayImage) -> (GrayImage, f32) {
    let (w, h) = gray.dimensions();
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let dark: Vec<(f32, f32)> = gray
        .enumerate_pixels()
        .filter(|(x, y, p)| p[0] < 128 && x % 2 == 0 && y % 2 == 0)
        .map(|(x, y, _)| (x as f32 - cx, y as f32 - cy))
        .collect();
    let mut best = (f64::MIN, 0.0f32);
    for step in -15..=15 {
        let angle = step as f32 * 0.2;
        let (s, c) = angle.to_radians().sin_cos();
        let mut rows = vec![0u32; (h as usize) * 2 + 8];
        for &(x, y) in &dark {
            let r = (x * s + y * c + h as f32) as usize;
            if r < rows.len() {
                rows[r] += 1;
            }
        }
        let score: f64 = rows.iter().map(|&v| (v as f64) * (v as f64)).sum();
        if score > best.0 {
            best = (score, angle);
        }
    }
    let angle = best.1;
    if angle.abs() < 0.1 {
        return (gray.clone(), 0.0);
    }
    (rotate(gray, angle), angle)
}

/// Rotate about the centre (bilinear), filling uncovered corners with white.
fn rotate(gray: &GrayImage, degrees: f32) -> GrayImage {
    let (w, h) = gray.dimensions();
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let (s, c) = degrees.to_radians().sin_cos();
    GrayImage::from_fn(w, h, |x, y| {
        // Inverse of the rotation used when scoring angles.
        let (dx, dy) = (x as f32 - cx, y as f32 - cy);
        let sx = dx * c + dy * s + cx;
        let sy = -dx * s + dy * c + cy;
        Luma([sample(gray, sx, sy)])
    })
}

fn sample(gray: &GrayImage, x: f32, y: f32) -> u8 {
    let (w, h) = gray.dimensions();
    if x < 0.0 || y < 0.0 || x > (w - 1) as f32 || y > (h - 1) as f32 {
        return 255;
    }
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let p = |xx, yy| gray.get_pixel(xx, yy)[0] as f32;
    let top = p(x0, y0) * (1.0 - fx) + p(x1, y0) * fx;
    let bottom = p(x0, y1) * (1.0 - fx) + p(x1, y1) * fx;
    (top * (1.0 - fy) + bottom * fy).round() as u8
}

/// Per row: the stretches of ink at least `min_len` long, after bridging gaps of up to 6 px.
/// Staff lines in shrunken or compressed screenshots are light grey and broken, so anything
/// clearly non-white counts as ink.
fn long_runs(gray: &GrayImage, min_len: u32) -> Vec<Vec<(u32, u32)>> {
    let (w, h) = gray.dimensions();
    (0..h)
        .map(|y| {
            let mut runs = Vec::new();
            let mut start: Option<u32> = None;
            let mut last_dark = 0u32;
            for x in 0..w {
                if gray.get_pixel(x, y)[0] < 215 {
                    match start {
                        Some(_) if x - last_dark <= 7 => {}
                        Some(s) => {
                            if last_dark + 1 - s >= min_len {
                                runs.push((s, last_dark));
                            }
                            start = Some(x);
                        }
                        None => start = Some(x),
                    }
                    last_dark = x;
                }
            }
            if let Some(s) = start {
                if last_dark + 1 - s >= min_len {
                    runs.push((s, last_dark));
                }
            }
            runs
        })
        .collect()
}

/// Center of each local maximum of the row profile. A 2–3 px thick line is a flat-topped peak
/// whose center can fall between rows (e.g. 813.5), and that half pixel matters.
fn line_centers(rows: &[f32], min_len: f32) -> Vec<f32> {
    let mut centers = Vec::new();
    let mut y = 1;
    while y + 1 < rows.len() {
        if rows[y] >= min_len && rows[y] > rows[y - 1] {
            let mut end = y;
            while end + 1 < rows.len() && rows[end + 1] == rows[y] {
                end += 1;
            }
            if end + 1 < rows.len() && rows[end + 1] < rows[y] {
                centers.push((y + end) as f32 / 2.0);
            }
            y = end + 1;
        } else {
            y += 1;
        }
    }
    centers
}

/// Five evenly spaced long lines with no other full-length line between them = one staff.
pub fn find_staves(gray: &GrayImage) -> Vec<Staff> {
    let (w, _) = gray.dimensions();
    let min_len = (w / 25).max(30);
    let runs = long_runs(gray, min_len);
    let rows: Vec<f32> = runs.iter().map(|r| r.iter().map(|(a, b)| (b - a + 1) as f32).sum()).collect();
    let strength = |p: f32| rows[p.round() as usize];
    let peaks = line_centers(&rows, min_len as f32);

    let mut staves = Vec::new();
    let mut used_until = f32::MIN;
    for (a, &first) in peaks.iter().enumerate() {
        if first <= used_until {
            continue;
        }
        for &second in peaks.iter().skip(a + 1).take(3) {
            let gap = second - first;
            if gap < 4.0 {
                continue;
            }
            let mut lines = vec![first, second];
            // Collect up to seven evenly spaced lines: a row of beams or noteheads one space
            // outside the staff can line up with it, and must not displace a real line.
            while lines.len() < 7 {
                // Re-estimate the spacing from the lines found so far, so rounding doesn't add up.
                let gap = (lines[lines.len() - 1] - lines[0]) / (lines.len() - 1) as f32;
                let target = lines[lines.len() - 1] + gap;
                let tolerance = (0.2 * gap).max(1.5);
                match peaks.iter().copied().filter(|p| (p - target).abs() <= tolerance).min_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs())) {
                    Some(p) => lines.push(p),
                    None => break,
                }
            }
            if lines.len() < 5 {
                continue;
            }
            // The real staff is the run of five whose weakest line is strongest: staff lines all
            // span the full width, a phantom row doesn't.
            let weakest_of = |w: &[f32]| w.iter().map(|&p| strength(p)).fold(f32::MAX, f32::min);
            let start = (0..=lines.len() - 5).max_by(|&a, &b| weakest_of(&lines[a..a + 5]).total_cmp(&weakest_of(&lines[b..b + 5]))).unwrap();
            let lines: Vec<f32> = lines[start..start + 5].to_vec();
            let strengths: Vec<f32> = lines.iter().map(|&p| strength(p)).collect();
            let weakest = strengths.iter().copied().fold(f32::MAX, f32::min);
            let strongest = strengths.iter().copied().fold(0.0, f32::max);
            // Lines from five different staves can also be evenly spaced; a real staff has no
            // other full-length line inside it.
            let intruders = peaks.iter().any(|&p| p > lines[0] && p < lines[4] && !lines.contains(&p) && strength(p) >= 0.5 * weakest);
            if weakest < 0.5 * strongest || intruders {
                continue;
            }
            let (left, right) = extent(&runs, lines[0], lines[4]);
            staves.push(Staff { top: lines[0], bottom: lines[4], space: (lines[4] - lines[0]) / 4.0, left, right });
            used_until = lines[4] + 1.0;
            break;
        }
    }
    staves
}

/// Leftmost and rightmost columns covered by long runs in at least 3 rows of the staff band.
fn extent(runs: &[Vec<(u32, u32)>], top: f32, bottom: f32) -> (u32, u32) {
    let mut cover: std::collections::BTreeMap<u32, i32> = Default::default();
    let y0 = (top as usize).saturating_sub(1);
    let y1 = ((bottom as usize) + 2).min(runs.len() - 1);
    for row in &runs[y0..=y1] {
        for &(a, b) in row {
            *cover.entry(a).or_default() += 1;
            *cover.entry(b + 1).or_default() -= 1;
        }
    }
    let (mut depth, mut left, mut right) = (0, None, 0);
    for (&x, &delta) in &cover {
        let before = depth;
        depth += delta;
        if before < 3 && depth >= 3 && left.is_none() {
            left = Some(x);
        }
        if before >= 3 && depth < 3 {
            right = x.saturating_sub(1);
        }
    }
    (left.unwrap_or(0), right)
}

/// A band around the staff, padded with white where it runs off the page, scaled to 16 px spacing.
pub fn crop_staff(gray: &GrayImage, staff: &Staff) -> StaffCrop {
    let sp = staff.space;
    let x0 = (staff.left as f32 - 2.0 * sp).floor();
    let x1 = (staff.right as f32 + 2.0 * sp).ceil();
    let y0 = (staff.top - SPACES_ABOVE * sp).round();
    let y1 = (staff.bottom + SPACES_BELOW * sp).round();
    let (w, h) = ((x1 - x0) as u32, (y1 - y0) as u32);
    let band = GrayImage::from_fn(w, h, |x, y| {
        let (px, py) = (x0 as i64 + x as i64, y0 as i64 + y as i64);
        if px < 0 || py < 0 || px >= gray.width() as i64 || py >= gray.height() as i64 {
            Luma([255])
        } else {
            *gray.get_pixel(px as u32, py as u32)
        }
    });
    let scale = STAFF_SPACE / sp;
    let target_h = ((4.0 + SPACES_ABOVE + SPACES_BELOW) * STAFF_SPACE) as u32;
    let target_w = ((w as f32 * scale).round() as u32).max(1);
    let filter = if scale < 1.0 { FilterType::Triangle } else { FilterType::CatmullRom };
    let resized = imageops::resize(&band, target_w, target_h, filter);
    let sy = target_h as f32 / h as f32;
    let image = image::DynamicImage::ImageLuma8(resized).to_rgb8();
    let (top_line, bottom_line) = refine_lines(&image, (staff.top - y0) * sy, (staff.bottom - y0) * sy);
    StaffCrop { image, page_box: [x0, y0, x1, y1], top_line, bottom_line }
}

/// Re-measure the staff lines inside the crop. The page-level estimate can be a pixel or two
/// off (beams lying on the top line skew its peak), which is enough to break barline detection.
fn refine_lines(crop: &RgbImage, top: f32, bottom: f32) -> (f32, f32) {
    let darkness = |y: i32| -> u32 {
        if y < 0 || y >= crop.height() as i32 {
            return 0;
        }
        (0..crop.width()).filter(|&x| crop.get_pixel(x, y as u32)[0] < 140).count() as u32
    };
    let spacing = (bottom - top) / 4.0;
    let lines: Vec<f32> = (0..5)
        .map(|k| {
            let expected = (top + k as f32 * spacing).round() as i32;
            let best = (expected - 4..=expected + 4).max_by_key(|&y| (darkness(y), -(y - expected).abs())).unwrap();
            // A 2 px line: center between its two darkest rows.
            let (above, below) = (darkness(best - 1), darkness(best + 1));
            let second = if above >= below { best - 1 } else { best + 1 };
            if darkness(second) * 10 >= darkness(best) * 7 { (best + second) as f32 / 2.0 } else { best as f32 }
        })
        .collect();
    (lines[0], lines[4])
}

/// X positions of barlines in a normalized crop: vertical strokes covering the whole staff
/// height and not continuing past it (note stems always stick out above or below).
pub fn find_barlines(crop: &RgbImage, top: f32, bottom: f32) -> Vec<f32> {
    let dark = |x: u32, y: f32| y >= 0.0 && (y as u32) < crop.height() && crop.get_pixel(x, y as u32)[0] < 140;
    // Only the inside of the staff must be fully covered; a 2 px line's edge rows may be pale.
    let (t, b) = ((top + 1.0).round(), (bottom - 1.0).round());
    let mut columns: Vec<u32> = Vec::new();
    for x in 0..crop.width() {
        let inside = (t as i32..=b as i32).filter(|&y| dark(x, y as f32)).count() as f32;
        if inside < 0.92 * (b - t + 1.0) {
            continue;
        }
        let pokes_out = |dir: f32| dark(x, if dir < 0.0 { t } else { b } + dir * 0.6 * STAFF_SPACE) && dark(x, if dir < 0.0 { t } else { b } + dir * 1.5 * STAFF_SPACE);
        if !pokes_out(-1.0) && !pokes_out(1.0) {
            columns.push(x);
        }
    }
    // Neighbouring columns (thick, double and final barlines) count as one.
    let mut lines: Vec<(u32, u32)> = Vec::new();
    for x in columns {
        match lines.last_mut() {
            Some((_, end)) if x as f32 - *end as f32 <= 0.75 * STAFF_SPACE => *end = x,
            _ => lines.push((x, x)),
        }
    }
    lines.into_iter().map(|(a, b)| (a + b) as f32 / 2.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A white page with staves drawn at the given top-line positions and spacing.
    fn page(staff_tops: &[u32], space: u32, barline_x: &[u32]) -> GrayImage {
        let mut img = GrayImage::from_pixel(1200, 900, Luma([255]));
        for &top in staff_tops {
            for line in 0..5 {
                for x in 100..1100 {
                    img.put_pixel(x, top + line * space, Luma([0]));
                    img.put_pixel(x, top + line * space + 1, Luma([0]));
                }
            }
            for &bx in barline_x {
                for y in top..=top + 4 * space + 1 {
                    img.put_pixel(bx, y, Luma([0]));
                    img.put_pixel(bx + 1, y, Luma([0]));
                }
            }
        }
        img
    }

    #[test]
    fn finds_every_staff_and_its_spacing() {
        let staves = find_staves(&page(&[100, 300, 500, 700], 14, &[]));
        assert_eq!(staves.len(), 4);
        for (s, top) in staves.iter().zip([100.5, 300.5, 500.5, 700.5]) {
            assert!((s.top - top).abs() < 0.6, "{} vs {top}", s.top);
            assert!((s.space - 14.0).abs() < 0.3);
            assert!(s.left <= 101 && s.right >= 1098);
        }
    }

    #[test]
    fn evenly_spaced_lines_of_different_staves_are_not_a_staff() {
        // Top lines 200 px apart: five of them line up but have other lines in between.
        let staves = find_staves(&page(&[100, 300, 500, 700], 14, &[]));
        assert!(staves.iter().all(|s| s.space < 20.0));
    }

    #[test]
    fn crops_to_16px_spacing_and_finds_barlines() {
        let img = page(&[300], 14, &[400, 700]);
        let staff = &find_staves(&img)[0];
        let crop = crop_staff(&img, staff);
        assert_eq!(crop.image.height(), 256);
        assert!((crop.top_line - 96.0).abs() < 1.5 && (crop.bottom_line - 160.0).abs() < 1.5);
        let bars = find_barlines(&crop.image, crop.top_line, crop.bottom_line);
        // Barlines at x = 400 and 700 on the page land 2 spaces + (x - left) scaled into the crop.
        let expect = |px: f32| (px + 0.5 - crop.page_box[0]) * STAFF_SPACE / staff.space;
        assert_eq!(bars.len(), 2, "{bars:?}");
        assert!((bars[0] - expect(400.0)).abs() < 2.0 && (bars[1] - expect(700.0)).abs() < 2.0, "{bars:?}");
    }

    #[test]
    fn a_row_of_ink_one_space_above_does_not_displace_the_top_line() {
        let mut img = page(&[300], 14, &[]);
        // A shorter but still long horizontal row exactly one space above the staff.
        for x in 300..700 {
            img.put_pixel(x, 286, Luma([0]));
        }
        let staves = find_staves(&img);
        assert_eq!(staves.len(), 1);
        assert!((staves[0].top - 300.5).abs() < 0.6 && (staves[0].bottom - 356.5).abs() < 0.6, "{:?}", staves[0]);
    }

    #[test]
    fn straightens_a_rotated_page() {
        let img = page(&[300, 500], 14, &[]);
        let tilted = rotate(&img, 1.2);
        let (_, angle) = deskew(&tilted);
        assert!((angle.abs() - 1.2).abs() < 0.25, "{angle}");
        assert_eq!(find_staves(&deskew(&tilted).0).len(), 2);
    }
}
