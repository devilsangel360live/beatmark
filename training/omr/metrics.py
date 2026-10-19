"""Simple, explainable scoring: per class, how many symbols were found and how many were wrong."""

from collections import defaultdict

import torch
from torchvision.ops import box_iou

from .common import CLASS_NAMES


class Scorer:
    """
    For each class counts:
      true positives  (TP): predicted box overlaps a real symbol of the same class (IoU ≥ 0.5)
      false positives (FP): predicted box with no matching real symbol
      false negatives (FN): real symbol nobody predicted
    precision = TP / (TP + FP)   "when it says notehead, how often is it right?"
    recall    = TP / (TP + FN)   "of all real noteheads, how many did it find?"
    """

    def __init__(self, score_threshold: float = 0.5, iou_threshold: float = 0.5):
        self.score_threshold = score_threshold
        self.iou_threshold = iou_threshold
        self.tp = defaultdict(int)
        self.fp = defaultdict(int)
        self.fn = defaultdict(int)

    def add(self, pred: dict, target: dict) -> None:
        keep = pred["scores"] >= self.score_threshold
        p_boxes, p_labels = pred["boxes"][keep].cpu(), pred["labels"][keep].cpu()
        t_boxes, t_labels = target["boxes"].cpu(), target["labels"].cpu()
        for cls in set(p_labels.tolist()) | set(t_labels.tolist()):
            pb, tb = p_boxes[p_labels == cls], t_boxes[t_labels == cls]
            matched = 0
            if len(pb) and len(tb):
                iou = box_iou(pb, tb)
                # Greedy one-to-one matching, best overlaps first.
                used_p, used_t = set(), set()
                for flat in torch.argsort(iou.flatten(), descending=True).tolist():
                    i, j = divmod(flat, iou.shape[1])
                    if iou[i, j] < self.iou_threshold:
                        break
                    if i not in used_p and j not in used_t:
                        used_p.add(i)
                        used_t.add(j)
                matched = len(used_p)
            self.tp[cls] += matched
            self.fp[cls] += len(pb) - matched
            self.fn[cls] += len(tb) - matched

    def summary(self) -> dict:
        rows = {}
        for cls in sorted(set(self.tp) | set(self.fp) | set(self.fn)):
            tp, fp, fn = self.tp[cls], self.fp[cls], self.fn[cls]
            p = tp / (tp + fp) if tp + fp else 0.0
            r = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * p * r / (p + r) if p + r else 0.0
            rows[CLASS_NAMES[cls - 1]] = {"precision": p, "recall": r, "f1": f1, "count": tp + fn}
        tp, fp, fn = sum(self.tp.values()), sum(self.fp.values()), sum(self.fn.values())
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        rows["ALL"] = {"precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0, "count": tp + fn}
        return rows

    def table(self) -> str:
        lines = [f"{'class':<16}{'count':>7}{'precision':>11}{'recall':>9}{'F1':>7}"]
        for name, s in self.summary().items():
            lines.append(f"{name:<16}{s['count']:>7}{s['precision']:>11.3f}{s['recall']:>9.3f}{s['f1']:>7.3f}")
        return "\n".join(lines)
