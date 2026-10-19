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
    keep_ref = ref["scores"].numpy() >= 0.5
    keep_onnx = scores >= 0.5
    print(f"PyTorch found {keep_ref.sum()} symbols, ONNX Runtime found {keep_onnx.sum()}")
    if keep_ref.sum() != keep_onnx.sum():
        raise SystemExit("Mismatch between PyTorch and ONNX outputs — do not ship this file.")
    diff = np.abs(ref["boxes"].numpy()[keep_ref] - boxes[keep_onnx]).max() if keep_ref.any() else 0.0
    print(f"Largest box difference: {diff:.3f} px — {'OK' if diff < 1.0 else 'TOO LARGE'}")


if __name__ == "__main__":
    main()
