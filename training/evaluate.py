"""
Score a trained model against labelled images (synthetic val set, or your labelled real crops).

    uv run evaluate.py runs/first-run/best.pt data/synth/val
    uv run evaluate.py runs/first-run/best.pt data/real/labelled

Prints precision, recall and F1 for every symbol class.
"""

import argparse

import torch
from tqdm import tqdm

from omr.common import load_checkpoint, pick_device
from omr.data import SymbolDataset
from omr.metrics import Scorer


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("split_dir", help="folder containing labels.jsonl and images/")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    device = pick_device(args.device)
    model = load_checkpoint(args.checkpoint, device)
    ds = SymbolDataset(args.split_dir, train=False)
    scorer = Scorer(score_threshold=args.threshold)
    with torch.no_grad():
        for i in tqdm(range(len(ds)), desc="scoring"):
            image, target = ds[i]
            scorer.add(model([image.to(device)])[0], target)
    print(scorer.table())


if __name__ == "__main__":
    main()
