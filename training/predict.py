"""
Run a trained model on images and draw what it found.

    uv run predict.py runs/first-run/best.pt data/real/crops --out predictions

Inputs must already be normalized system crops (synthetic images, or the output of
prepare_real.py). Each output image shows the predicted boxes with confidence scores.
"""

import argparse
from pathlib import Path

import cv2
import torch

from omr.common import load_checkpoint, pick_device
from show_labels import draw

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("inputs", nargs="+", help="image files or folders")
    ap.add_argument("--out", default="predictions")
    ap.add_argument("--threshold", type=float, default=0.5, help="hide boxes below this confidence")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    device = pick_device(args.device)
    model = load_checkpoint(args.checkpoint, device)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    files = []
    for p in map(Path, args.inputs):
        files += sorted(f for f in p.rglob("*") if f.suffix.lower() in IMAGE_EXTS) if p.is_dir() else [p]
    for f in files:
        bgr = cv2.imread(str(f))
        tensor = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float() / 255.0
        with torch.no_grad():
            pred = model([tensor.to(device)])[0]
        keep = pred["scores"] >= args.threshold
        boxes = pred["boxes"][keep].cpu().tolist()
        labels = [l - 1 for l in pred["labels"][keep].cpu().tolist()]
        scores = pred["scores"][keep].cpu().tolist()
        img = cv2.resize(draw(bgr, boxes, labels, scores), None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(str(out / f"{f.stem}.png"), img)
        print(f"{f.name}: {len(boxes)} symbols")
    print(f"Drawn predictions are in {out}/")


if __name__ == "__main__":
    main()
