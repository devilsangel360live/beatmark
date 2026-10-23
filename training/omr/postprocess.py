"""
Rules applied to the detector's raw output. The app's Rust code must apply the same rules.

Grace notes use the same notehead shape as normal notes, only smaller. Faster R-CNN resizes
every candidate box to a fixed 7x7 grid before classifying it, which removes most of the size
difference, so on its own it confuses the two. Because every staff is normalized to 16 px
line spacing, box size is a reliable cue instead: a filled notehead well below the typical
notehead height of its staff is a grace note.
"""

import torch
from torchvision.ops import batched_nms

from .common import CLASS_NAMES

HEAD = CLASS_NAMES.index("head_black") + 1
GRACE = CLASS_NAMES.index("grace_head") + 1
GRACE_RATIO = 0.85


def resolve_grace_notes(pred: dict, min_score: float = 0.3) -> dict:
    """Relabel filled noteheads as normal or grace by their height, then remove duplicates."""
    boxes, labels, scores = pred["boxes"], pred["labels"].clone(), pred["scores"]
    heads = ((labels == HEAD) | (labels == GRACE)) & (scores >= min_score)
    if heads.sum() < 2:
        return pred
    heights = boxes[heads, 3] - boxes[heads, 1]
    # Most noteheads in a staff are normal, so the upper quartile is a safe "full size".
    full = torch.quantile(heights, 0.75)
    is_grace = heights < GRACE_RATIO * full
    labels[heads] = torch.where(is_grace, torch.tensor(GRACE, device=labels.device), torch.tensor(HEAD, device=labels.device))
    # The detector often proposed both classes for one notehead; after relabelling they collide.
    keep = batched_nms(boxes, scores, labels, 0.5)
    keep = keep[torch.argsort(scores[keep], descending=True)]
    return {"boxes": boxes[keep], "labels": labels[keep], "scores": scores[keep]}


def postprocess(pred: dict) -> dict:
    return resolve_grace_notes(pred)
