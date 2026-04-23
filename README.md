# rubic-cube-solver

Rubik's Cube capture + validation app (FastAPI + OpenCV + frontend UI).

## AutoGrid (new)

The backend can now auto-locate and warp a cube face to a clean 3×3 square before color detection.

### Modes

- `AUTOGRID_MODE=hybrid` (default): try YOLO first, then classic CV, then center fallback.
- `AUTOGRID_MODE=yolo`: YOLO only, then center fallback.
- `AUTOGRID_MODE=classic`: contour-based OpenCV only, then center fallback.

### YOLO config

- `AUTOGRID_YOLO_MODEL=/absolute/path/to/model.pt`
- `AUTOGRID_YOLO_CONF=0.35`
- `AUTOGRID_WARP_SIZE=360`

If model path is missing/invalid, app still works through classic/fallback paths.

## Install

From [backend/requirements.txt](backend/requirements.txt):

- fastapi
- uvicorn
- opencv-python
- numpy
- kociemba
- python-multipart
- ultralytics
