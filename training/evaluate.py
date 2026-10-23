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
from omr.postprocess import postprocess


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint")
    ap.add_argument("split_dir", help="folder containing labels.jsonl and images/")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--raw", action="store_true", help="score the detector alone, without the grace-note size rule")
    args = ap.parse_args()

    device = pick_device(args.device)
    model = load_checkpoint(args.checkpoint, device)
    ds = SymbolDataset(args.split_dir, train=False)
    scorer = Scorer(score_threshold=args.threshold)
    with torch.no_grad():
        for i in tqdm(range(len(ds)), desc="scoring"):
            image, target = ds[i]
            pred = {k: v.cpu() for k, v in model([image.to(device)])[0].items()}
            scorer.add(pred if args.raw else postprocess(pred), target)
    print(scorer.table())


if __name__ == "__main__":
    main()
