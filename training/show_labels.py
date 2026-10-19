"""
Draw the labelled boxes onto images so you can check the labels are right.

    uv run show_labels.py data/synth/train --count 20
    uv run show_labels.py data/synth/train --augment     # also apply the random degradation

Output goes to <split>/preview/. Open the PNGs and check every box hugs its symbol.
"""

import argparse
import random
from pathlib import Path

import cv2
import numpy as np

from omr.common import CLASS_NAMES
from omr.data import SymbolDataset, read_labels


def color_for(cls: int) -> tuple[int, int, int]:
    rng = random.Random(cls * 7919)
    return tuple(int(c) for c in rng.sample(range(40, 220), 3))


def draw(img: np.ndarray, boxes, labels, scores=None) -> np.ndarray:
    """Boxes plus a short class name. `labels` are class ids (0-based)."""
    img = img.copy()
    for k, ((x0, y0, x1, y1), cls) in enumerate(zip(boxes, labels)):
        c = color_for(int(cls))
        cv2.rectangle(img, (int(x0), int(y0)), (int(x1), int(y1)), c, 1)
        name = CLASS_NAMES[int(cls)].replace("head_", "").replace("timesig_", "ts")
        text = name if scores is None else f"{name} {scores[k]:.2f}"
        cv2.putText(img, text, (int(x0), max(8, int(y0) - 2)), cv2.FONT_HERSHEY_PLAIN, 0.7, c, 1, cv2.LINE_AA)
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("split_dir", help="folder containing labels.jsonl and images/")
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--augment", action="store_true", help="show training-time degradation too")
    args = ap.parse_args()

    split = Path(args.split_dir)
    out = split / "preview"
    out.mkdir(exist_ok=True)
    records = read_labels(split)
    ds = SymbolDataset(split, train=True) if args.augment else None
    for i, rec in enumerate(records[: args.count]):
        if ds:
            tensor, target = ds[i]
            img = (tensor.permute(1, 2, 0).numpy() * 255).astype(np.uint8)
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            boxes, labels = target["boxes"].tolist(), [l - 1 for l in target["labels"].tolist()]
        else:
            img = cv2.imread(str(split / rec["image"]))
            boxes, labels = [b[1:] for b in rec["boxes"]], [b[0] for b in rec["boxes"]]
        # Enlarge 2x so small boxes are easy to inspect.
        img = cv2.resize(draw(img, boxes, labels), None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(str(out / Path(rec["image"]).name), img)
    print(f"Wrote {min(args.count, len(records))} previews to {out}")


if __name__ == "__main__":
    main()
