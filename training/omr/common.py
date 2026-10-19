"""Shared pieces: the class list, device choice, and the detector model."""

import json
import os
from pathlib import Path

# Some detection ops lack Apple-GPU (MPS) kernels; let PyTorch fall back to CPU for those.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch  # noqa: E402

TRAINING_DIR = Path(__file__).resolve().parent.parent
_classes_file = json.loads((TRAINING_DIR / "classes.json").read_text())
CLASS_NAMES: list[str] = [c["name"] for c in _classes_file["classes"]]
STAFF_SPACE_PX: int = _classes_file["normalization"]["staff_space_px"]


def pick_device(requested: str = "auto") -> torch.device:
    """Apple GPU (mps) on a Mac, NVIDIA GPU (cuda) if present, otherwise CPU."""
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def build_model(pretrained: bool = True) -> torch.nn.Module:
    """
    Faster R-CNN (ResNet-50 FPN), a well-understood object detector from torchvision
    (BSD licence). We start from weights trained on everyday photos (COCO) and retrain
    it for music symbols: much faster than learning from scratch.
    """
    from torchvision.models.detection import FasterRCNN_ResNet50_FPN_Weights, fasterrcnn_resnet50_fpn
    from torchvision.models.detection.anchor_utils import AnchorGenerator
    from torchvision.models.detection.faster_rcnn import FastRCNNPredictor

    model = fasterrcnn_resnet50_fpn(
        weights=FasterRCNN_ResNet50_FPN_Weights.COCO_V1 if pretrained else None,
        # Images are 256 px tall; enlarging 1.5x gives tiny symbols (dots) enough pixels.
        # (2x is a little more accurate but 2.3x slower to train on an M1 Pro.)
        min_size=384,
        max_size=4096,
        # A busy system can hold hundreds of symbols (the default cap is 100).
        box_detections_per_img=400,
        box_score_thresh=0.05,
    )
    # Music symbols are smaller and more elongated than objects in photos:
    # beams are wide and flat (ratio 0.25), flags tall and narrow (ratio 2).
    model.rpn.anchor_generator = AnchorGenerator(
        sizes=((16,), (32,), (64,), (128,), (256,)),
        aspect_ratios=((0.25, 1.0, 2.0),) * 5,
    )
    in_features = model.roi_heads.box_predictor.cls_score.in_features
    # +1 because torchvision reserves class 0 for "background".
    model.roi_heads.box_predictor = FastRCNNPredictor(in_features, len(CLASS_NAMES) + 1)
    return model


def load_checkpoint(path: str | Path, device: torch.device) -> torch.nn.Module:
    model = build_model(pretrained=False)
    state = torch.load(path, map_location="cpu", weights_only=True)
    model.load_state_dict(state["model"] if "model" in state else state)
    return model.to(device).eval()
