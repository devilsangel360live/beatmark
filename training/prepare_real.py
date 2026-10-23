"""
Turn real screenshots / PDFs into model-ready crops: one image per staff, scaled so the
staff lines are 16 px apart (the same format as the synthetic training data).

    uv run prepare_real.py ~/Desktop/drum-screens/*.png ~/Desktop/lesson.pdf --out data/real/crops

For each input it also writes <name>_debug.png showing the staves it found (green) so
you can check nothing was missed.
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from omr.common import STAFF_SPACE_PX

ABOVE, BELOW = 6, 6  # staff spaces kept above the top line and below the bottom line (matches classes.json)


def load_pages(path: Path) -> list[np.ndarray]:
    """BGR images: one per PDF page (rendered at 200 dpi), or the image itself."""
    if path.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        return [cv2.cvtColor(np.array(page.render(scale=200 / 72).to_pil().convert("RGB")), cv2.COLOR_RGB2BGR) for page in pdf]
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"Could not read {path}")
    return [img]


def deskew(gray: np.ndarray) -> tuple[np.ndarray, float]:
    """Straighten slightly rotated scans: pick the angle where staff lines give the sharpest row profile."""
    dark = (gray < 128).astype(np.uint8)
    small = cv2.resize(dark, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    h, w = small.shape
    best, best_angle = -1.0, 0.0
    for angle in np.arange(-3, 3.01, 0.2):
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
        rows = cv2.warpAffine(small, m, (w, h)).sum(axis=1).astype(np.float64)
        score = float((rows**2).sum())
        if score > best:
            best, best_angle = score, float(angle)
    if abs(best_angle) < 0.1:
        return gray, 0.0
    h, w = gray.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), best_angle, 1)
    return cv2.warpAffine(gray, m, (w, h), borderValue=255), best_angle


def find_staves(gray: np.ndarray) -> list[dict]:
    """Five evenly spaced long horizontal lines = one staff. Returns their positions and spacing."""
    # Thin staff lines in shrunken or compressed screenshots turn light grey and broken, so
    # count anything clearly non-white as ink and bridge small gaps before measuring runs.
    dark = (gray < 215).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 1)))
    # Keep only long horizontal runs (staff lines), erasing notes, stems and text.
    min_len = max(30, gray.shape[1] // 25)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (min_len, 1))
    lines_only = cv2.morphologyEx(dark, cv2.MORPH_OPEN, kernel)
    rows = lines_only.sum(axis=1).astype(np.float64)

    # Each staff line is a peak in the row profile. Beams make peaks too, so a staff is
    # five peaks at an even spacing, with any extra peaks in between ignored.
    peaks = line_centers(rows, min_len)
    strength = lambda p: rows[int(round(p))]
    staves, used_until = [], float("-inf")
    for a, first in enumerate(peaks):
        # Skip everything up to the bottom of the staff just found (as the Rust port does).
        if first <= used_until:
            continue
        for second in peaks[a + 1 : a + 4]:
            gap = second - first
            if gap < 4:
                continue
            lines = [first, second]
            # Collect up to seven evenly spaced lines: a row of beams or noteheads one space
            # outside the staff can line up with it, and must not displace a real line.
            while len(lines) < 7:
                # Re-estimate the spacing from the lines found so far, so rounding doesn't add up.
                gap = (lines[-1] - lines[0]) / (len(lines) - 1)
                target = lines[-1] + gap
                near = [p for p in peaks if abs(p - target) <= max(1.5, 0.2 * gap)]
                if not near:
                    break
                lines.append(min(near, key=lambda p: abs(p - target)))
            if len(lines) < 5:
                continue
            # The real staff is the run of five whose weakest line is strongest.
            start = max(range(len(lines) - 4), key=lambda i: min(strength(y) for y in lines[i : i + 5]))
            lines = lines[start : start + 5]
            strengths = [strength(y) for y in lines]
            # Inside a real staff the only full-length lines are its own five. Without this,
            # lines from five different staves that happen to be evenly spaced (e.g. the top
            # line of each staff on a page) pass as one giant "staff".
            weakest = min(strengths)
            intruders = [p for p in peaks if lines[0] < p < lines[-1] and p not in lines and strength(p) >= 0.5 * weakest]
            # Lines of one staff are about equally long; a stray beam isn't.
            if weakest >= 0.5 * max(strengths) and not intruders:
                band = lines_only[int(lines[0]) - 1 : int(lines[-1]) + 3]
                cols = np.where(band.sum(axis=0) >= 3)[0]
                staves.append({"top": float(lines[0]), "bottom": float(lines[-1]), "space": (lines[-1] - lines[0]) / 4,
                               "left": int(cols.min()), "right": int(cols.max())})
                used_until = lines[-1] + 1
                break
    return staves


def line_centers(rows: np.ndarray, min_len: int) -> list[float]:
    """
    Center of each local maximum in the row profile. A line two or three pixels thick is a
    flat-topped peak; its center can fall between rows (e.g. 813.5), and that half pixel matters
    when five lines must line up.
    """
    centers, y = [], 1
    while y < len(rows) - 1:
        if rows[y] >= min_len and rows[y] > rows[y - 1]:
            end = y
            while end + 1 < len(rows) and rows[end + 1] == rows[y]:
                end += 1
            if end + 1 < len(rows) and rows[end + 1] < rows[y]:
                centers.append((y + end) / 2)
            y = end + 1
        else:
            y += 1
    return centers


def crop_staff(gray: np.ndarray, staff: dict) -> tuple[np.ndarray, list[int]]:
    """A band around the staff, padded with white if it runs off the page, rescaled to 16 px spacing."""
    sp = staff["space"]
    x0, x1 = int(staff["left"] - 2 * sp), int(staff["right"] + 2 * sp)
    y0, y1 = int(round(staff["top"] - ABOVE * sp)), int(round(staff["bottom"] + BELOW * sp))
    h, w = gray.shape
    padded = cv2.copyMakeBorder(gray, max(0, -y0), max(0, y1 - h), max(0, -x0), max(0, x1 - w), cv2.BORDER_CONSTANT, value=255)
    oy, ox = max(0, -y0), max(0, -x0)
    band = padded[y0 + oy : y1 + oy, x0 + ox : x1 + ox]
    scale = STAFF_SPACE_PX / sp
    target_h = (4 + ABOVE + BELOW) * STAFF_SPACE_PX
    resized = cv2.resize(band, (max(1, round(band.shape[1] * scale)), target_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    return resized, [x0, y0, x1, y1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="PNG/JPEG/TIFF screenshots or PDF files")
    ap.add_argument("--out", default="data/real/crops")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "debug").mkdir(parents=True, exist_ok=True)
    total = 0
    with open(out / "crops.jsonl", "a") as manifest:
        for path in map(Path, args.inputs):
            for page_no, page in enumerate(load_pages(path), start=1):
                gray, angle = deskew(cv2.cvtColor(page, cv2.COLOR_BGR2GRAY))
                staves = find_staves(gray)
                debug = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
                suffix = f"_p{page_no}" if path.suffix.lower() == ".pdf" else ""
                for k, staff in enumerate(staves, start=1):
                    crop, box = crop_staff(gray, staff)
                    name = f"{path.stem}{suffix}_s{k}.png"
                    # Saved as 3-channel so it matches the synthetic images.
                    cv2.imwrite(str(out / name), cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR))
                    manifest.write(json.dumps({"crop": name, "source": str(path), "page": page_no, "box": box, "deskew_degrees": angle, "staff_space": staff["space"]}) + "\n")
                    cv2.rectangle(debug, (box[0], box[1]), (box[2], box[3]), (0, 180, 0), 2)
                    cv2.putText(debug, f"staff {k}", (box[0] + 4, box[1] + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 140, 0), 2)
                cv2.imwrite(str(out / "debug" / f"{path.stem}{suffix}_debug.png"), debug)
                print(f"{path.name}{f' page {page_no}' if suffix else ''}: {len(staves)} staves (deskewed {angle:+.1f}°)")
                total += len(staves)
    print(f"{total} crops written to {out}/  — check {out}/debug/ to see what was found")


if __name__ == "__main__":
    main()
