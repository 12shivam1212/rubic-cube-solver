from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

import cv2
import numpy as np


COLOR_KEYS = ("W", "R", "G", "Y", "O", "B")

# HSV prototypes used for fallback nearest-color classification.
# OpenCV HSV: H in [0,179], S/V in [0,255].
HSV_PROTOTYPES: dict[str, tuple[int, int, int]] = {
    "W": (0, 20, 230),
    "R": (0, 180, 180),
    "O": (17, 200, 200),
    "Y": (30, 200, 220),
    "G": (60, 190, 180),
    "B": (110, 200, 180),
}

AUTOGRID_MODE = os.getenv("AUTOGRID_MODE", "hybrid").strip().lower()
AUTOGRID_YOLO_MODEL = os.getenv("AUTOGRID_YOLO_MODEL", "")
AUTOGRID_YOLO_CONF = float(os.getenv("AUTOGRID_YOLO_CONF", "0.35"))
AUTOGRID_WARP_SIZE = int(os.getenv("AUTOGRID_WARP_SIZE", "360"))

_YOLO_MODEL = None
_YOLO_LOAD_ERROR: str | None = None


@dataclass
class DetectionResult:
    grid: list[str]  # 9 letters in row-major order
    confidence: list[float]
    roi: dict[str, int]
    autogrid: dict[str, Any] | None = None
    center_corrected: bool = False
    expected_center: str | None = None
    center_hsv: list[int] | None = None


def _gray_world_white_balance(bgr: np.ndarray) -> np.ndarray:
    """
    Simple gray-world white balance to reduce warm/cool lighting bias.
    """
    bgr_f = bgr.astype(np.float32)
    b_mean = float(np.mean(bgr_f[:, :, 0]))
    g_mean = float(np.mean(bgr_f[:, :, 1]))
    r_mean = float(np.mean(bgr_f[:, :, 2]))
    avg = (b_mean + g_mean + r_mean) / 3.0

    if b_mean > 0:
        bgr_f[:, :, 0] *= avg / b_mean
    if g_mean > 0:
        bgr_f[:, :, 1] *= avg / g_mean
    if r_mean > 0:
        bgr_f[:, :, 2] *= avg / r_mean

    return np.clip(bgr_f, 0, 255).astype(np.uint8)


def _largest_center_square(image: np.ndarray) -> tuple[np.ndarray, dict[str, int]]:
    h, w = image.shape[:2]
    side = min(h, w)
    x = (w - side) // 2
    y = (h - side) // 2
    return image[y : y + side, x : x + side], {"x": x, "y": y, "size": side}


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    """Return points ordered as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.astype(np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)

    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _warp_from_quad(image: np.ndarray, quad: np.ndarray, size: int = AUTOGRID_WARP_SIZE) -> np.ndarray:
    ordered = _order_quad_points(quad)
    dst = np.array(
        [[0, 0], [size - 1, 0], [size - 1, size - 1], [0, size - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(image, matrix, (size, size), flags=cv2.INTER_LINEAR)


def _load_yolo_model():
    global _YOLO_MODEL, _YOLO_LOAD_ERROR
    if _YOLO_MODEL is not None:
        return _YOLO_MODEL
    if _YOLO_LOAD_ERROR:
        return None
    if not AUTOGRID_YOLO_MODEL:
        _YOLO_LOAD_ERROR = "AUTOGRID_YOLO_MODEL is not set"
        return None
    if not os.path.exists(AUTOGRID_YOLO_MODEL):
        _YOLO_LOAD_ERROR = f"YOLO model file not found: {AUTOGRID_YOLO_MODEL}"
        return None

    try:
        from ultralytics import YOLO  # type: ignore

        _YOLO_MODEL = YOLO(AUTOGRID_YOLO_MODEL)
        return _YOLO_MODEL
    except Exception as exc:
        _YOLO_LOAD_ERROR = str(exc)
        return None


def _autogrid_with_yolo(image: np.ndarray) -> tuple[np.ndarray, dict[str, Any]] | None:
    model = _load_yolo_model()
    if model is None:
        return None

    try:
        results = model.predict(source=image, conf=AUTOGRID_YOLO_CONF, max_det=1, verbose=False)
    except Exception:
        return None

    if not results:
        return None

    r0 = results[0]
    if getattr(r0, "boxes", None) is None or len(r0.boxes) == 0:
        return None

    box = r0.boxes[0]
    conf = float(box.conf.item()) if getattr(box, "conf", None) is not None else 0.0
    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(np.float32).tolist()
    quad = np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32)
    warped = _warp_from_quad(image, quad)

    return warped, {
        "used": True,
        "mode": "yolo",
        "confidence": round(conf, 4),
        "quad": [[int(p[0]), int(p[1])] for p in quad],
        "fallback_used": False,
    }


def _autogrid_with_classic(image: np.ndarray) -> tuple[np.ndarray, dict[str, Any]] | None:
    h, w = image.shape[:2]
    image_area = float(h * w)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    edges = cv2.Canny(gray, 70, 180)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    best_quad = None
    best_score = -1e18

    cx_img, cy_img = w / 2.0, h / 2.0

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < image_area * 0.04:
            continue

        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)

        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad = approx.reshape(4, 2).astype(np.float32)
        else:
            rect = cv2.minAreaRect(cnt)
            rw, rh = rect[1]
            if rw < 20 or rh < 20:
                continue
            quad = cv2.boxPoints(rect).astype(np.float32)

        ordered = _order_quad_points(quad)
        top_w = np.linalg.norm(ordered[1] - ordered[0])
        bot_w = np.linalg.norm(ordered[2] - ordered[3])
        left_h = np.linalg.norm(ordered[3] - ordered[0])
        right_h = np.linalg.norm(ordered[2] - ordered[1])

        width = (top_w + bot_w) * 0.5
        height = (left_h + right_h) * 0.5
        if width < 20 or height < 20:
            continue

        aspect = max(width, height) / max(1.0, min(width, height))
        if aspect > 1.9:
            continue

        c = np.mean(ordered, axis=0)
        center_dist = np.linalg.norm(c - np.array([cx_img, cy_img], dtype=np.float32))

        area_norm = area / max(1.0, image_area)
        score = (area_norm * 1000.0) - (center_dist * 0.35) - ((aspect - 1.0) * 120.0)

        if score > best_score:
            best_score = score
            best_quad = ordered

    if best_quad is None:
        return None

    warped = _warp_from_quad(image, best_quad)
    area_est = cv2.contourArea(best_quad.reshape(-1, 1, 2))
    confidence = float(max(0.45, min(0.95, (area_est / max(1.0, image_area)) * 2.2)))

    return warped, {
        "used": True,
        "mode": "classic",
        "confidence": round(confidence, 4),
        "quad": [[int(p[0]), int(p[1])] for p in best_quad],
        "fallback_used": False,
    }


def _autogrid_extract_face(image: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    mode = AUTOGRID_MODE if AUTOGRID_MODE in {"yolo", "classic", "hybrid"} else "hybrid"

    if mode in {"yolo", "hybrid"}:
        yolo_out = _autogrid_with_yolo(image)
        if yolo_out is not None:
            return yolo_out
        if mode == "yolo":
            fallback_img, fallback_roi = _largest_center_square(image)
            return fallback_img, {
                "used": False,
                "mode": "fallback-center-square",
                "confidence": 0.0,
                "quad": None,
                "fallback_used": True,
                "reason": _YOLO_LOAD_ERROR or "YOLO detection failed",
                "roi": fallback_roi,
            }

    if mode in {"classic", "hybrid"}:
        classic_out = _autogrid_with_classic(image)
        if classic_out is not None:
            return classic_out

    fallback_img, fallback_roi = _largest_center_square(image)
    return fallback_img, {
        "used": False,
        "mode": "fallback-center-square",
        "confidence": 0.0,
        "quad": None,
        "fallback_used": True,
        "reason": "Classic autogrid failed",
        "roi": fallback_roi,
    }


def _circular_hue_mean(h_values: np.ndarray) -> int:
    """
    Circular mean for OpenCV hue values in [0, 179].
    """
    if h_values.size == 0:
        return 0
    radians = (h_values.astype(np.float32) * 2.0) * (np.pi / 180.0)
    sin_m = float(np.mean(np.sin(radians)))
    cos_m = float(np.mean(np.cos(radians)))
    angle = np.arctan2(sin_m, cos_m)
    if angle < 0:
        angle += 2 * np.pi
    hue_deg = angle * (180.0 / np.pi)
    return int((hue_deg / 2.0) % 180)


def _robust_hsv_from_patch(patch_hsv: np.ndarray) -> tuple[int, int, int]:
    pixels = patch_hsv.reshape(-1, 3)
    s = pixels[:, 1]
    v = pixels[:, 2]

    # Keep colorful and visible pixels to avoid black borders/shadows.
    colorful = pixels[(s > 45) & (v > 45)]
    if colorful.shape[0] >= 20:
        h_val = _circular_hue_mean(colorful[:, 0])
        s_val = int(np.percentile(colorful[:, 1], 60))
        v_val = int(np.percentile(colorful[:, 2], 60))
        return h_val, s_val, v_val

    # Fallback for white / low-saturation cells.
    h_val = _circular_hue_mean(pixels[:, 0])
    s_val = int(np.percentile(pixels[:, 1], 50))
    v_val = int(np.percentile(pixels[:, 2], 65))
    return h_val, s_val, v_val


def _hsv_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    ah, as_, av = a
    bh, bs, bv = b
    hue_dist = min(abs(ah - bh), 180 - abs(ah - bh))
    return (hue_dist * 2.0) ** 2 + ((as_ - bs) * 0.7) ** 2 + ((av - bv) * 0.6) ** 2



def _classify_hsv(
    h: int,
    s: int,
    v: int,
    calibration: dict[str, tuple[int, int, int]] | None = None,
) -> tuple[str, float]:
    if calibration and len(calibration) >= 3:
        # Calibrated classification improves color separation under varying lighting.
        best_color = "W"
        best_dist = float("inf")

        for color in COLOR_KEYS:
            ref = calibration.get(color, HSV_PROTOTYPES[color])
            dist = _hsv_distance((h, s, v), ref)

            # White should be low saturation; penalize high-sat samples for white class.
            if color == "W" and s > 75:
                dist += (s - 75) * 22

            if dist < best_dist:
                best_dist = dist
                best_color = color

        confidence = float(max(0.45, min(0.95, 1.0 - (best_dist / 70000.0))))
        return best_color, confidence

    # Rule-based fast path.
    if s < 62 and v > 110:
        conf = float(max(0.72, min(0.97, 0.97 - (s / 220.0))))
        return "W", conf

    if (h < 9 or h >= 170) and s > 60 and v > 45:
        return "R", 0.92
    if 9 <= h < 24 and s > 75 and v > 50:
        return "O", 0.90
    if 24 <= h < 40 and s > 70 and v > 55:
        return "Y", 0.90
    if 40 <= h < 90 and s > 60 and v > 45:
        return "G", 0.88
    if 90 <= h < 140 and s > 60 and v > 45:
        return "B", 0.88

    # Fallback nearest prototype in HSV space (cyclic hue distance).
    best_color = "W"
    best_dist = float("inf")
    for color, (ph, ps, pv) in HSV_PROTOTYPES.items():
        hue_dist = min(abs(h - ph), 180 - abs(h - ph))
        dist = (hue_dist * 2.0) ** 2 + ((s - ps) * 0.7) ** 2 + ((v - pv) * 0.6) ** 2
        if dist < best_dist:
            best_dist = dist
            best_color = color

    confidence = float(max(0.40, min(0.85, 1.0 - (best_dist / 60000.0))))
    return best_color, confidence



def _center_square_roi(image: np.ndarray, ratio: float = 0.58) -> tuple[np.ndarray, dict[str, int]]:
    h, w = image.shape[:2]
    side = int(min(h, w) * ratio)
    x = (w - side) // 2
    y = (h - side) // 2
    roi = image[y : y + side, x : x + side]
    return roi, {"x": x, "y": y, "size": side}


def detect_face_from_image_bytes(
    image_bytes: bytes,
    expected_center: str | None = None,
    calibration: dict[str, tuple[int, int, int]] | None = None,
) -> DetectionResult:
    np_bytes = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(np_bytes, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("Could not decode image")

    bgr = _gray_world_white_balance(bgr)

    roi_bgr, autogrid_meta = _autogrid_extract_face(bgr)
    roi_meta = (
        autogrid_meta.get("roi")
        if isinstance(autogrid_meta, dict) and autogrid_meta.get("roi")
        else {"x": 0, "y": 0, "size": int(min(roi_bgr.shape[0], roi_bgr.shape[1]))}
    )
    if roi_bgr.shape[0] < 90 or roi_bgr.shape[1] < 90:
        raise ValueError("Captured ROI is too small. Move closer and recapture.")

    # Light denoise for camera noise.
    roi_bgr = cv2.GaussianBlur(roi_bgr, (3, 3), 0)

    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)

    side = hsv.shape[0]
    cell = side // 3

    grid: list[str] = []
    confidence: list[float] = []
    cell_hsv: list[tuple[int, int, int]] = []

    for r in range(3):
        for c in range(3):
            y0 = r * cell
            x0 = c * cell
            y1 = side if r == 2 else (r + 1) * cell
            x1 = side if c == 2 else (c + 1) * cell

            patch = hsv[y0:y1, x0:x1]
            if patch.size == 0:
                raise ValueError("Empty cell patch detected")

            # Sample central region for stability.
            ph, pw = patch.shape[:2]
            cy0, cy1 = int(ph * 0.30), int(ph * 0.70)
            cx0, cx1 = int(pw * 0.30), int(pw * 0.70)
            core = patch[cy0:cy1, cx0:cx1]
            if core.size == 0:
                core = patch

            h, s, v = _robust_hsv_from_patch(core)
            cell_hsv.append((h, s, v))

            color, conf = _classify_hsv(h, s, v, calibration=calibration)
            grid.append(color)
            confidence.append(round(conf, 3))

    center_corrected = False
    if expected_center in COLOR_KEYS and grid[4] != expected_center:
        # If center is uncertain, force expected center to avoid capture dead-ends.
        if confidence[4] < 0.92:
            grid[4] = expected_center
            confidence[4] = round(max(confidence[4], 0.55), 3)
            center_corrected = True

    return DetectionResult(
        grid=grid,
        confidence=confidence,
        roi=roi_meta,
        autogrid=autogrid_meta,
        center_corrected=center_corrected,
        expected_center=expected_center,
        center_hsv=list(cell_hsv[4]) if len(cell_hsv) >= 5 else None,
    )



def make_color_grid_payload(grid: list[str]) -> list[list[str]]:
    if len(grid) != 9:
        raise ValueError("Face grid must contain 9 color values")
    return [grid[0:3], grid[3:6], grid[6:9]]



def as_debug_dict(result: DetectionResult) -> dict[str, Any]:
    return {
        "grid": result.grid,
        "grid_2d": make_color_grid_payload(result.grid),
        "confidence": result.confidence,
        "roi": result.roi,
        "autogrid": result.autogrid,
        "center_corrected": result.center_corrected,
        "expected_center": result.expected_center,
        "center_hsv": result.center_hsv,
    }
