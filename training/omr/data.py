"""Loading labelled images and making them look like real-world screenshots."""

import json
import random
from pathlib import Path

import albumentations as A
import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

MAX_TRAIN_WIDTH = 768


def read_labels(split_dir: Path) -> list[dict]:
    """One record per image from <split_dir>/labels.jsonl."""
    with open(split_dir / "labels.jsonl") as f:
        return [json.loads(line) for line in f if line.strip()]


def degrade() -> A.Compose:
    """
    Random damage applied every time an image is loaded, so the model never sees exactly
    the same picture twice and learns to cope with blurry, compressed, tilted screenshots.
    """
    return A.Compose(
        [
            A.Downscale(scale_range=(0.35, 0.9), p=0.5),
            A.ImageCompression(quality_range=(20, 90), p=0.6),
            A.GaussianBlur(blur_limit=(3, 5), p=0.2),
            A.Affine(rotate=(-2, 2), shear=(-1.5, 1.5), scale=(0.95, 1.05), border_mode=cv2.BORDER_CONSTANT, fill=255, p=0.5),
            A.GaussNoise(std_range=(0.02, 0.08), p=0.3),
            A.RandomBrightnessContrast(brightness_limit=0.25, contrast_limit=0.35, p=0.5),
            A.RandomGamma(p=0.3),
            A.ColorJitter(hue=0.5, saturation=0.5, p=0.25),
            A.InvertImg(p=0.05),  # dark-mode screenshots
        ],
        bbox_params=A.BboxParams(format="pascal_voc", label_fields=["labels"], min_visibility=0.6),
    )


def add_overlays(img: np.ndarray, rng: random.Random) -> np.ndarray:
    """Things seen on video screenshots: a translucent playback cursor and stray text."""
    h, w = img.shape[:2]
    if rng.random() < 0.25:
        x = rng.randrange(0, w)
        color = np.array([rng.randrange(256) for _ in range(3)], dtype=np.float32)
        band = img[:, x : x + rng.randrange(4, 40)].astype(np.float32)
        img[:, x : x + band.shape[1]] = (band * 0.65 + color * 0.35).astype(np.uint8)
    if rng.random() < 0.2:
        text = rng.choice(["R L R L", "Verse", "x4", "Chorus", "mf", "Groove A", "sim.", "R R L L"])
        y = rng.choice([rng.randrange(14, 40), rng.randrange(h - 30, h - 6)])
        cv2.putText(img, text, (rng.randrange(0, max(1, w - 120)), y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (40, 40, 40), 1, cv2.LINE_AA)
    return img


class SymbolDataset(Dataset):
    """
    Returns (image tensor, target) pairs in the format torchvision detectors expect:
    target["boxes"] is [N, 4] as x0, y0, x1, y1 and target["labels"] is class id + 1.
    """

    def __init__(self, split_dir: str | Path, train: bool):
        self.dir = Path(split_dir)
        self.records = read_labels(self.dir)
        self.train = train
        self.aug = degrade() if train else None

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, i: int):
        rec = self.records[i]
        img = cv2.cvtColor(cv2.imread(str(self.dir / rec["image"])), cv2.COLOR_BGR2RGB)
        boxes = np.array([b[1:] for b in rec["boxes"]], dtype=np.float32).reshape(-1, 4)
        labels = np.array([b[0] + 1 for b in rec["boxes"]], dtype=np.int64)

        if self.train:
            rng = random.Random()
            img, boxes, labels = random_width_crop(img, boxes, labels, rng)
            img = add_overlays(img, rng)
            boxes, labels = clip_boxes(boxes, labels, img.shape[1], img.shape[0])
            out = self.aug(image=img, bboxes=boxes, labels=labels)
            img = out["image"]
            boxes = np.array(out["bboxes"], dtype=np.float32).reshape(-1, 4)
            labels = np.array(out["labels"], dtype=np.int64)

        tensor = torch.from_numpy(img).permute(2, 0, 1).float() / 255.0
        return tensor, {"boxes": torch.from_numpy(boxes), "labels": torch.from_numpy(labels)}


def random_width_crop(img, boxes, labels, rng: random.Random):
    """Training uses a window at most 768 px wide, which keeps memory and time down."""
    h, w = img.shape[:2]
    if w <= MAX_TRAIN_WIDTH:
        return img, boxes, labels
    x0 = rng.randrange(0, w - MAX_TRAIN_WIDTH)
    x1 = x0 + MAX_TRAIN_WIDTH
    if len(boxes):
        inside = np.clip(np.minimum(boxes[:, 2], x1) - np.maximum(boxes[:, 0], x0), 0, None)
        keep = inside >= 0.6 * (boxes[:, 2] - boxes[:, 0])
        boxes, labels = boxes[keep].copy(), labels[keep]
        boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]] - x0, 0, MAX_TRAIN_WIDTH)
    return np.ascontiguousarray(img[:, x0:x1]), boxes, labels


def clip_boxes(boxes: np.ndarray, labels: np.ndarray, w: int, h: int):
    """Keep boxes inside the image, dropping any that collapse (and their labels)."""
    if len(boxes) == 0:
        return boxes, labels
    boxes = boxes.copy()
    boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w - 0.01)
    boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h - 0.01)
    keep = (boxes[:, 2] - boxes[:, 0] > 1) & (boxes[:, 3] - boxes[:, 1] > 1)
    return boxes[keep], labels[keep]


def collate(batch):
    return tuple(zip(*batch))
