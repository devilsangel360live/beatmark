"""
Helpers for labelling real crops in Label Studio (a free labelling app that runs in your browser).

    uv run labelstudio.py config                       # print the labelling interface to paste into Label Studio
    uv run labelstudio.py prelabel CKPT data/real/crops # optional: let the model draw first guesses for you to fix
    uv run labelstudio.py import EXPORT_DIR data/real/labelled
                                                       # convert Label Studio's YOLO export into our format

See GUIDE.md, step 6, for the full walk-through.
"""

import argparse
import json
import shutil
from pathlib import Path

import cv2

from omr.common import CLASS_NAMES

IMAGE_EXTS = {".png", ".jpg", ".jpeg"}


def config() -> None:
    from show_labels import color_for

    labels = "\n".join(
        f'    <Label value="{name}" background="#{"".join(f"{c:02x}" for c in reversed(color_for(i)))}"/>' for i, name in enumerate(CLASS_NAMES)
    )
    print(
        f"""<View>
  <Image name="image" value="$image" zoom="true" zoomControl="true" rotateControl="false"/>
  <RectangleLabels name="label" toName="image" strokeWidth="1" opacity="0.25">
{labels}
  </RectangleLabels>
</View>"""
    )


def prelabel(checkpoint: str, crops: Path, out_file: Path, threshold: float) -> None:
    """Writes Label Studio tasks whose boxes come from the model, so you only correct mistakes."""
    import torch

    from omr.common import load_checkpoint, pick_device
    from omr.postprocess import postprocess

    device = pick_device()
    model = load_checkpoint(checkpoint, device)
    tasks = []
    for f in sorted(p for p in crops.iterdir() if p.suffix.lower() in IMAGE_EXTS):
        bgr = cv2.imread(str(f))
        h, w = bgr.shape[:2]
        tensor = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float() / 255.0
        with torch.no_grad():
            pred = postprocess({k: v.cpu() for k, v in model([tensor.to(device)])[0].items()})
        results = []
        for (x0, y0, x1, y1), label, score in zip(pred["boxes"].tolist(), pred["labels"].tolist(), pred["scores"].tolist()):
            if score < threshold:
                continue
            results.append({
                "from_name": "label", "to_name": "image", "type": "rectanglelabels",
                "original_width": w, "original_height": h,
                "value": {"x": 100 * x0 / w, "y": 100 * y0 / h, "width": 100 * (x1 - x0) / w, "height": 100 * (y1 - y0) / h,
                          "rectanglelabels": [CLASS_NAMES[label - 1]]},
            })
        # Label Studio serves local files from LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT under this URL.
        tasks.append({"data": {"image": f"/data/local-files/?d={f.resolve().relative_to(Path.home())}"},
                      "predictions": [{"model_version": Path(checkpoint).parent.name, "result": results}]})
    out_file.write_text(json.dumps(tasks, indent=1))
    print(f"Wrote {len(tasks)} tasks to {out_file}")


def import_yolo(export_dir: Path, out: Path) -> None:
    """Label Studio 'YOLO' export: images/, labels/*.txt (class cx cy w h, 0–1), classes.txt."""
    names = (export_dir / "classes.txt").read_text().split()
    (out / "images").mkdir(parents=True, exist_ok=True)
    count = 0
    with open(out / "labels.jsonl", "w") as f:
        for img_path in sorted((export_dir / "images").iterdir()):
            if img_path.suffix.lower() not in IMAGE_EXTS:
                continue
            h, w = cv2.imread(str(img_path)).shape[:2]
            boxes = []
            label_file = export_dir / "labels" / f"{img_path.stem}.txt"
            for line in label_file.read_text().splitlines() if label_file.exists() else []:
                k, cx, cy, bw, bh = line.split()
                name = names[int(k)]
                if name not in CLASS_NAMES:
                    raise SystemExit(f"Unknown label '{name}' in {label_file}")
                cx, cy, bw, bh = float(cx) * w, float(cy) * h, float(bw) * w, float(bh) * h
                boxes.append([CLASS_NAMES.index(name), round(cx - bw / 2, 1), round(cy - bh / 2, 1), round(cx + bw / 2, 1), round(cy + bh / 2, 1)])
            shutil.copy(img_path, out / "images" / img_path.name)
            f.write(json.dumps({"image": f"images/{img_path.name}", "width": w, "height": h, "boxes": boxes}) + "\n")
            count += 1
    print(f"Imported {count} labelled images into {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("config")
    p = sub.add_parser("prelabel")
    p.add_argument("checkpoint")
    p.add_argument("crops", type=Path)
    p.add_argument("--out", type=Path, default=Path("data/real/prelabel-tasks.json"))
    p.add_argument("--threshold", type=float, default=0.4)
    i = sub.add_parser("import")
    i.add_argument("export_dir", type=Path)
    i.add_argument("out", type=Path)
    args = ap.parse_args()
    if args.cmd == "config":
        config()
    elif args.cmd == "prelabel":
        prelabel(args.checkpoint, args.crops, args.out, args.threshold)
    else:
        import_yolo(args.export_dir, args.out)


if __name__ == "__main__":
    main()
