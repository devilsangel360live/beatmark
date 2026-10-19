"""
Train the drum-symbol detector.

    uv run train.py --data data/synth --epochs 3 --name first-run

Checkpoints are saved to runs/<name>/: last.pt after every epoch, best.pt when the
validation score improves. Stop at any time with Ctrl+C and continue later with
--resume runs/<name>/last.pt.
"""

import argparse
import json
import math
import time
from pathlib import Path

import torch
from torch.utils.data import ConcatDataset, DataLoader
from tqdm import tqdm

from omr.common import TRAINING_DIR, build_model, pick_device
from omr.data import SymbolDataset, collate
from omr.metrics import Scorer


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/synth", help="folder with train/ and val/ inside")
    ap.add_argument("--name", default="run", help="name of the folder under runs/")
    ap.add_argument("--epochs", type=int, default=3, help="passes over the training set")
    ap.add_argument("--batch", type=int, default=4, help="images per step; lower it if you run out of memory")
    ap.add_argument("--lr", type=float, default=0.01, help="learning rate (step size)")
    ap.add_argument("--workers", type=int, default=4, help="CPU processes preparing images")
    ap.add_argument("--device", default="auto", help="auto, mps, cuda or cpu")
    ap.add_argument("--resume", help="checkpoint to continue an interrupted run from")
    ap.add_argument("--init", help="start from this trained model's weights (fine-tuning), with a fresh schedule")
    ap.add_argument("--extra", nargs="*", default=[], help="more labelled folders to train on, e.g. your real images")
    ap.add_argument("--extra-repeat", type=int, default=20, help="how many times each extra image is repeated per epoch")
    ap.add_argument("--max-steps", type=int, help="stop early (for a quick smoke test)")
    ap.add_argument("--val-limit", type=int, default=500, help="validation images scored per epoch")
    args = ap.parse_args()

    device = pick_device(args.device)
    data = Path(args.data)
    out = TRAINING_DIR / "runs" / args.name
    out.mkdir(parents=True, exist_ok=True)
    print(f"Device: {device}. Saving to {out}")

    train_ds = SymbolDataset(data / "train", train=True)
    # A few dozen real images would be drowned out by 20k synthetic ones, so repeat them.
    extras = [SymbolDataset(d, train=True) for d in args.extra]
    if extras:
        train_ds = ConcatDataset([train_ds, *(e for e in extras for _ in range(args.extra_repeat))])
    val_ds = SymbolDataset(data / "val", train=False)
    print(f"{len(train_ds)} training images (incl. repeats), {len(val_ds)} validation images")
    loader = DataLoader(
        train_ds,
        batch_size=args.batch,
        shuffle=True,
        num_workers=args.workers,
        collate_fn=collate,
        persistent_workers=args.workers > 0,
    )

    model = build_model(pretrained=not (args.resume or args.init))
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location="cpu", weights_only=True)["model"])
        print(f"Starting from {args.init}")
    model.to(device)
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.SGD(params, lr=args.lr, momentum=0.9, weight_decay=1e-4)
    total_steps = args.max_steps or args.epochs * len(loader)
    warmup = min(500, total_steps // 10)
    # Ramp the learning rate up for the first few hundred steps, then ease it down to zero.
    schedule = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lambda s: (s + 1) / warmup if s < warmup else 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, total_steps - warmup))),
    )

    start_epoch, step, best = 0, 0, -1.0
    if args.resume:
        ckpt = torch.load(args.resume, map_location="cpu", weights_only=False)
        model.load_state_dict(ckpt["model"])
        optimizer.load_state_dict(ckpt["optimizer"])
        schedule.load_state_dict(ckpt["schedule"])
        start_epoch, step, best = ckpt["epoch"] + 1, ckpt["step"], ckpt.get("best", -1.0)
        print(f"Resumed from {args.resume} at epoch {start_epoch}")

    for epoch in range(start_epoch, args.epochs):
        model.train()
        started = time.time()
        bar = tqdm(loader, desc=f"epoch {epoch + 1}/{args.epochs}")
        for images, targets in bar:
            images = [im.to(device) for im in images]
            targets = [{k: v.to(device) for k, v in t.items()} for t in targets]
            losses = model(images, targets)
            loss = sum(losses.values())
            if not math.isfinite(loss.item()):
                raise SystemExit(f"Loss became {loss.item()} — try a lower --lr")
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 10.0)
            optimizer.step()
            schedule.step()
            step += 1
            bar.set_postfix(loss=f"{loss.item():.3f}", lr=f"{schedule.get_last_lr()[0]:.4f}")
            if args.max_steps and step >= args.max_steps:
                break

        scorer = validate(model, val_ds, device, args.val_limit)
        f1 = scorer.summary()["ALL"]["f1"]
        print(scorer.table())
        print(f"epoch {epoch + 1}: validation F1 {f1:.3f} ({(time.time() - started) / 60:.1f} min)")

        ckpt = {"model": model.state_dict(), "optimizer": optimizer.state_dict(), "schedule": schedule.state_dict(),
                "epoch": epoch, "step": step, "best": max(best, f1)}
        torch.save(ckpt, out / "last.pt")
        if f1 > best:
            best = f1
            torch.save({"model": model.state_dict()}, out / "best.pt")
            print(f"  new best → {out / 'best.pt'}")
        with open(out / "history.jsonl", "a") as f:
            f.write(json.dumps({"epoch": epoch + 1, "step": step, "val_f1": f1, "per_class": scorer.summary()}) + "\n")
        if args.max_steps and step >= args.max_steps:
            break


@torch.no_grad()
def validate(model, ds, device, limit: int) -> Scorer:
    model.eval()
    scorer = Scorer()
    for i in tqdm(range(min(limit, len(ds))), desc="validating", leave=False):
        image, target = ds[i]
        pred = model([image.to(device)])[0]
        scorer.add(pred, target)
    model.train()
    return scorer


if __name__ == "__main__":
    main()
