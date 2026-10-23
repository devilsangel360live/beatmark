"""
Convert a trained checkpoint into an ONNX file the desktop app can run (via the `ort` crate).

    uv run export_onnx.py runs/first-run/best.pt --sample data/synth/val/images/0000003.png

Writes ../src-tauri/models/drum-omr.onnx, then runs the same image through PyTorch and
ONNX Runtime and checks they agree.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch

from omr.common import CLASS_NAMES, TRAINING_DIR, load_checkpoint


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("--sample", required=True, help="an image used to verify the export")
    ap.add_argument("--out", default=str(TRAINING_DIR.parent / "src-tauri" / "models" / "drum-omr.onnx"))
    args = ap.parse_args()

    model = load_checkpoint(args.checkpoint, torch.device("cpu"))
    rgb = cv2.cvtColor(cv2.imread(args.sample), cv2.COLOR_BGR2RGB)
    image = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Input: one RGB image, float 0–1, shape [3, height, width]. Outputs: boxes, labels, scores.
    torch.onnx.export(
        model,
        ([image],),
        str(out),
        opset_version=17,
        input_names=["image"],
        output_names=["boxes", "labels", "scores"],
        dynamic_axes={"image": {1: "height", 2: "width"}, "boxes": {0: "n"}, "labels": {0: "n"}, "scores": {0: "n"}},
        dynamo=False,
    )
    (out.parent / "drum-omr.classes.txt").write_text("\n".join(["background", *CLASS_NAMES]) + "\n")
    print(f"Wrote {out} ({out.stat().st_size / 1e6:.0f} MB)")

    with torch.no_grad():
        ref = model([image])[0]
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    boxes, labels, scores = sess.run(None, {"image": image.numpy()})
    a = confident(ref["boxes"].numpy(), ref["labels"].numpy(), ref["scores"].numpy())
    b = confident(boxes, labels, scores)
    print(f"PyTorch found {len(a)} symbols, ONNX Runtime found {len(b)}")
    if len(a) != len(b) or any(x[0] != y[0] for x, y in zip(a, b)):
        raise SystemExit("Mismatch between PyTorch and ONNX outputs — do not ship this file.")
    diff = max((np.abs(x[1] - y[1]).max() for x, y in zip(a, b)), default=0.0)
    print(f"Largest box difference: {diff:.3f} px — {'OK' if diff < 1.0 else 'TOO LARGE'}")


def confident(boxes, labels, scores, threshold=0.5):
    """Detections above the threshold in a fixed order. Ties in score (common at 1.00)
    can come back in a different order from each runtime, so compare sorted lists."""
    keep = scores >= threshold
    rows = sorted(zip(labels[keep].tolist(), boxes[keep].tolist()), key=lambda r: (r[0], r[1]))
    return [(label, np.array(box)) for label, box in rows]


if __name__ == "__main__":
    main()
