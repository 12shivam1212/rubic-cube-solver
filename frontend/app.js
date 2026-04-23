const FACE_ORDER = ["U", "R", "F", "D", "L", "B"];
const FACE_NAMES = {
  U: "YELLOW center (U)",
  R: "RED center (R)",
  F: "GREEN center (F)",
  D: "WHITE center (D)",
  L: "ORANGE center (L)",
  B: "BLUE center (B)",
};

const COLOR_HEX = {
  W: "#f3f4f6",
  R: "#ef4444",
  G: "#22c55e",
  Y: "#facc15",
  O: "#f97316",
  B: "#3b82f6",
};

const COLOR_OPTIONS = ["W", "R", "G", "Y", "O", "B"];
const COLOR_NAME = {
  W: "White",
  R: "Red",
  G: "Green",
  Y: "Yellow",
  O: "Orange",
  B: "Blue",
};

const video = document.getElementById("video");
const overlay = document.querySelector(".overlay-grid");
const edgeTop = document.getElementById("edgeTop");
const edgeRight = document.getElementById("edgeRight");
const edgeBottom = document.getElementById("edgeBottom");
const edgeLeft = document.getElementById("edgeLeft");
const canvas = document.getElementById("snapshotCanvas");
const ctx = canvas.getContext("2d");

const stepText = document.getElementById("stepText");
const statusText = document.getElementById("statusText");
const facesContainer = document.getElementById("facesContainer");
const resultBox = document.getElementById("resultBox");
const colorPicker = document.getElementById("colorPicker");
const correctionHelp = document.getElementById("correctionHelp");
const progressFaces = document.getElementById("progressFaces");
const orientationGuide = document.getElementById("orientationGuide");

const startBtn = document.getElementById("startBtn");
const flipBtn = document.getElementById("flipBtn");
const autogridBtn = document.getElementById("autogridBtn");
const captureBtn = document.getElementById("captureBtn");
const retakeBtn = document.getElementById("retakeBtn");
const finalizeBtn = document.getElementById("finalizeBtn");
const demoBtn = document.getElementById("demoBtn");
const demoScrambleBtn = document.getElementById("demoScrambleBtn");
const clearBtn = document.getElementById("clearBtn");
const autogridInfo = document.getElementById("autogridInfo");

let stream = null;
let currentFaceIndex = 0;
let faces = {}; // { U:[9], R:[9], ... }
let isBusy = false;
let selectedSticker = null; // { faceKey, index }
let colorCalibration = {}; // { W:[h,s,v], R:[h,s,v], ... }
let isVideoFlipped = false;
let isAutogridEnabled = true;

const FACE_CENTER_COLOR = { U: "Y", R: "R", F: "G", D: "W", L: "O", B: "B" };

const ORIENTATION_DOTS = {
  U: { top: "B", left: "O", right: "R", bottom: "G" },
  R: { top: "Y", left: "G", right: "B", bottom: "W" },
  F: { top: "Y", left: "O", right: "R", bottom: "W" },
  D: { top: "G", left: "O", right: "R", bottom: "B" },
  L: { top: "Y", left: "B", right: "G", bottom: "W" },
  B: { top: "Y", left: "R", right: "O", bottom: "W" },
};

function setStatus(msg, kind = "") {
  statusText.textContent = msg;
  statusText.className = `status ${kind}`.trim();
}

function renderColorPicker() {
  if (!colorPicker) return;
  colorPicker.innerHTML = "";

  COLOR_OPTIONS.forEach((color) => {
    const btn = document.createElement("button");
    btn.className = "color-btn";
    btn.type = "button";
    btn.style.background = COLOR_HEX[color];
    btn.textContent = `${COLOR_NAME[color]} (${color})`;
    btn.disabled = !selectedSticker;

    btn.addEventListener("click", () => {
      if (!selectedSticker) return;
      const { faceKey, index } = selectedSticker;
      if (!faces[faceKey]) return;
      faces[faceKey][index] = color;
      renderFacePreviews();
      updateCorrectionHelp();
      setStatus(`Updated ${faceKey} sticker ${index + 1} to ${COLOR_NAME[color]}.`, "good");
    });

    colorPicker.appendChild(btn);
  });
}

function updateCorrectionHelp() {
  if (!correctionHelp) return;
  if (!selectedSticker) {
    correctionHelp.textContent = "Click any sticker in Captured Faces to edit it.";
    return;
  }
  const { faceKey, index } = selectedSticker;
  const color = faces[faceKey]?.[index] || "?";
  correctionHelp.textContent = `Selected: face ${faceKey}, sticker ${index + 1}, current color ${color}. Choose a new color below.`;
}

function selectSticker(faceKey, index) {
  selectedSticker = { faceKey, index };
  renderFacePreviews();
  updateCorrectionHelp();
  renderColorPicker();
}

function currentFaceKey() {
  return FACE_ORDER[currentFaceIndex];
}

function setEdgeReference(element, colorCode) {
  if (!element) return;
  element.style.background = COLOR_HEX[colorCode] || "#9ca3af";
  element.title = `Reference: ${colorCode}`;
}

function renderOverlayReferences(faceKey) {
  if (!faceKey || !ORIENTATION_DOTS[faceKey]) {
    setEdgeReference(edgeTop, "Y");
    setEdgeReference(edgeRight, "R");
    setEdgeReference(edgeBottom, "W");
    setEdgeReference(edgeLeft, "O");
    return;
  }

  const ref = ORIENTATION_DOTS[faceKey];
  setEdgeReference(edgeTop, ref.top);
  setEdgeReference(edgeRight, ref.right);
  setEdgeReference(edgeBottom, ref.bottom);
  setEdgeReference(edgeLeft, ref.left);
}

function renderOrientationGuide(faceKey) {
  if (!orientationGuide) return;
  const map = ORIENTATION_DOTS[faceKey];
  if (!map) {
    orientationGuide.innerHTML = "";
    return;
  }

  const center = FACE_CENTER_COLOR[faceKey];
  orientationGuide.innerHTML = `
    <div class="orientation-title">Orientation guide (hold like this)</div>
    <div class="orientation-grid">
      <div></div>
      <div class="ori-dot" style="background:${COLOR_HEX[map.top]}">${map.top}</div>
      <div></div>
      <div class="ori-dot" style="background:${COLOR_HEX[map.left]}">${map.left}</div>
      <div class="ori-dot center" style="background:${COLOR_HEX[center]}">${center}</div>
      <div class="ori-dot" style="background:${COLOR_HEX[map.right]}">${map.right}</div>
      <div></div>
      <div class="ori-dot" style="background:${COLOR_HEX[map.bottom]}">${map.bottom}</div>
      <div></div>
    </div>
    <div class="orientation-note">Center = face you are capturing now</div>
  `;
}

function renderProgressFaces() {
  if (!progressFaces) return;
  progressFaces.innerHTML = "";

  FACE_ORDER.forEach((faceKey, idx) => {
    const pill = document.createElement("span");
    const isDone = !!faces[faceKey] && idx < currentFaceIndex;
    const isActive = idx === currentFaceIndex && currentFaceIndex < FACE_ORDER.length;
    pill.className = `face-pill${isDone ? " done" : ""}${isActive ? " active" : ""}`;
    pill.textContent = `${faceKey}${isDone ? " ✓" : ""}`;
    progressFaces.appendChild(pill);
  });
}

function updateStepInstruction() {
  if (currentFaceIndex >= FACE_ORDER.length) {
    stepText.textContent = "All faces captured. Click Validate Cube State.";
    renderOrientationGuide(null);
    renderOverlayReferences(null);
    renderProgressFaces();
    return;
  }
  const key = currentFaceKey();
  stepText.textContent = `Face ${currentFaceIndex + 1}/6: Show ${FACE_NAMES[key]} and press any key to capture.`;
  renderOrientationGuide(key);
  renderOverlayReferences(key);
  renderProgressFaces();
}

function createFaceCard(faceKey, grid) {
  const card = document.createElement("div");
  card.className = "face-card";

  const title = document.createElement("div");
  title.className = "face-title";
  title.textContent = `${faceKey} - ${FACE_NAMES[faceKey]}`;

  const gridEl = document.createElement("div");
  gridEl.className = "grid3";

  grid.forEach((c, i) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    if (selectedSticker && selectedSticker.faceKey === faceKey && selectedSticker.index === i) {
      cell.classList.add("selected");
    }
    cell.style.background = COLOR_HEX[c] || "#6b7280";
    cell.title = `${c} (click to edit)`;
    cell.style.cursor = "pointer";
    cell.addEventListener("click", () => selectSticker(faceKey, i));
    gridEl.appendChild(cell);
  });

  card.appendChild(title);
  card.appendChild(gridEl);
  return card;
}

function renderFacePreviews() {
  facesContainer.innerHTML = "";
  FACE_ORDER.forEach((faceKey) => {
    if (faces[faceKey]) {
      facesContainer.appendChild(createFaceCard(faceKey, faces[faceKey]));
    }
  });
}

function renderSolutionViewer(solution, cubeState) {
  const moves = solution.trim().split(/\s+/).filter(Boolean);
  const movePills = moves
    .map((m, idx) => `<span class="move-pill">${idx + 1}. ${m}</span>`)
    .join("");

  const twistySupported = typeof customElements !== "undefined" && customElements.get("twisty-player");

  resultBox.innerHTML = `
    <div class="good"><strong>Cube is valid and solvable.</strong></div>
    <div>Cube state: <code>${cubeState}</code></div>
    <div>Solution: <code>${solution}</code></div>
    <div class="solution-wrap">
      ${
        twistySupported
          ? `<twisty-player
               class="twisty"
               puzzle="3x3x3"
               alg="${solution}"
               background="none"
               control-panel="bottom-row"
               tempo-scale="1.1"
             ></twisty-player>`
          : `<div class="bad">3D player unavailable in this browser/network. Showing move list only.</div>`
      }
      <div class="move-list">${movePills || "<span class=\"muted\">No moves returned.</span>"}</div>
    </div>
  `;
}

function renderRotationRecoveryInfo(data) {
  if (!data?.resolved_by_rotation || !data?.rotation_turns_clockwise) return "";

  const entries = Object.entries(data.rotation_turns_clockwise)
    .map(([face, turns]) => `${face}: ${turns * 90}°`)
    .join(" • ");

  return `<div class="warn"><strong>Auto orientation fix applied:</strong> ${entries}</div>`;
}

function updateButtons() {
  const started = !!stream;
  startBtn.disabled = started;
  if (flipBtn) flipBtn.disabled = !started || isBusy;
  if (autogridBtn) autogridBtn.disabled = isBusy;
  captureBtn.disabled = !started || currentFaceIndex >= FACE_ORDER.length || isBusy;
  retakeBtn.disabled = !started || currentFaceIndex === 0 || isBusy;
  finalizeBtn.disabled = currentFaceIndex < FACE_ORDER.length || isBusy;
  if (demoBtn) demoBtn.disabled = isBusy;
  if (demoScrambleBtn) demoScrambleBtn.disabled = isBusy;
  if (clearBtn) clearBtn.disabled = isBusy;
}

function updateAutogridButton() {
  if (!autogridBtn) return;
  autogridBtn.textContent = `AutoGrid: ${isAutogridEnabled ? "ON" : "OFF"}`;
}

function renderAutogridInfo(meta = null) {
  if (!autogridInfo) return;

  if (!meta) {
    autogridInfo.textContent = isAutogridEnabled
      ? "AutoGrid enabled: backend will locate the 3×3 face automatically."
      : "AutoGrid disabled: capture uses fixed center overlay crop.";
    autogridInfo.className = "status";
    return;
  }

  const mode = meta.mode || "unknown";
  const conf = typeof meta.confidence === "number" ? ` (conf ${meta.confidence.toFixed(2)})` : "";
  const fallback = meta.fallback_used ? " • fallback used" : "";
  const reason = meta.reason ? ` • ${meta.reason}` : "";
  autogridInfo.textContent = `Detector: ${mode}${conf}${fallback}${reason}`;
  autogridInfo.className = `status ${meta.fallback_used ? "warn" : "good"}`;
}

function applyVideoFlip() {
  if (!video) return;
  video.style.transform = isVideoFlipped ? "scaleX(-1)" : "none";
  if (flipBtn) {
    flipBtn.textContent = `Flip Video: ${isVideoFlipped ? "ON" : "OFF"}`;
  }
}

function toggleVideoFlip() {
  if (!stream || isBusy) return;
  isVideoFlipped = !isVideoFlipped;
  applyVideoFlip();
  setStatus(`Video flip ${isVideoFlipped ? "enabled" : "disabled"}.`, "good");
}

function toggleAutogrid() {
  if (isBusy) return;
  isAutogridEnabled = !isAutogridEnabled;
  updateAutogridButton();
  renderAutogridInfo();
  setStatus(
    isAutogridEnabled
      ? "AutoGrid enabled. You no longer need perfect manual alignment."
      : "AutoGrid disabled. Use overlay alignment as before.",
    "good"
  );
}

function loadDemoInput() {
  if (isBusy) return;

  // Standard solved orientation used by this app:
  // U=Y, R=R, F=G, D=W, L=O, B=B
  faces = {
    U: ["Y", "Y", "Y", "Y", "Y", "Y", "Y", "Y", "Y"],
    R: ["R", "R", "R", "R", "R", "R", "R", "R", "R"],
    F: ["G", "G", "G", "G", "G", "G", "G", "G", "G"],
    D: ["W", "W", "W", "W", "W", "W", "W", "W", "W"],
    L: ["O", "O", "O", "O", "O", "O", "O", "O", "O"],
    B: ["B", "B", "B", "B", "B", "B", "B", "B", "B"],
  };

  currentFaceIndex = FACE_ORDER.length;
  selectedSticker = null;
  colorCalibration = {};

  renderFacePreviews();
  updateCorrectionHelp();
  renderColorPicker();
  updateStepInstruction();
  updateButtons();
  resultBox.innerHTML = "";
  setStatus("Demo input loaded. Click Validate Cube State.", "good");
}

function loadDemoScrambledInput() {
  if (isBusy) return;

  // Valid solvable state = solved cube after a single U turn.
  // Orientation used by this app: U=Y, R=R, F=G, D=W, L=O, B=B
  faces = {
    U: ["Y", "Y", "Y", "Y", "Y", "Y", "Y", "Y", "Y"],
    R: ["G", "G", "G", "R", "R", "R", "R", "R", "R"],
    F: ["O", "O", "O", "G", "G", "G", "G", "G", "G"],
    D: ["W", "W", "W", "W", "W", "W", "W", "W", "W"],
    L: ["B", "B", "B", "O", "O", "O", "O", "O", "O"],
    B: ["R", "R", "R", "B", "B", "B", "B", "B", "B"],
  };

  currentFaceIndex = FACE_ORDER.length;
  selectedSticker = null;
  colorCalibration = {};

  renderFacePreviews();
  updateCorrectionHelp();
  renderColorPicker();
  updateStepInstruction();
  updateButtons();
  resultBox.innerHTML = "";
  setStatus("Demo scrambled input loaded. Click Validate Cube State.", "good");
}

function clearAllInput() {
  if (isBusy) return;
  faces = {};
  currentFaceIndex = 0;
  selectedSticker = null;
  colorCalibration = {};

  renderFacePreviews();
  updateCorrectionHelp();
  renderColorPicker();
  updateStepInstruction();
  updateButtons();
  resultBox.innerHTML = "";
  setStatus("Input cleared. Start capture again.");
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 1) {
        resolve();
      } else {
        video.onloadedmetadata = () => resolve();
      }
    });
    isVideoFlipped = false;
    applyVideoFlip();
    setStatus("Camera started. Keep one face centered inside white square and fill most of it.");
    updateButtons();
    updateStepInstruction();
  } catch (err) {
    setStatus(`Camera error: ${err.message}`, "bad");
  }
}

function getSnapshotBlob() {
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;

  if (!vw || !vh) {
    return Promise.resolve(null);
  }

  if (!overlay) {
    canvas.width = vw;
    canvas.height = vh;
    ctx.drawImage(video, 0, 0, vw, vh);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  }

  const videoRect = video.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();

  const containerW = videoRect.width;
  const containerH = videoRect.height;
  const containerAspect = containerW / containerH;
  const sourceAspect = vw / vh;

  let srcX = 0;
  let srcY = 0;
  let srcW = vw;
  let srcH = vh;

  // Match CSS object-fit: cover mapping.
  if (sourceAspect > containerAspect) {
    srcW = vh * containerAspect;
    srcX = (vw - srcW) / 2;
  } else {
    srcH = vw / containerAspect;
    srcY = (vh - srcH) / 2;
  }

  const ox = overlayRect.left - videoRect.left;
  const oy = overlayRect.top - videoRect.top;
  const ow = overlayRect.width;
  const oh = overlayRect.height;

  // If preview is flipped, map overlay X back to source coordinates accordingly.
  const mappedOx = isVideoFlipped ? containerW - (ox + ow) : ox;

  if (isAutogridEnabled) {
    canvas.width = Math.max(1, Math.round(srcW));
    canvas.height = Math.max(1, Math.round(srcH));
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  }

  const sx = Math.max(0, Math.round(srcX + (mappedOx / containerW) * srcW));
  const sy = Math.max(0, Math.round(srcY + (oy / containerH) * srcH));
  const sw = Math.max(1, Math.round((ow / containerW) * srcW));
  const sh = Math.max(1, Math.round((oh / containerH) * srcH));

  const side = Math.max(1, Math.min(sw, sh, vw - sx, vh - sy));
  canvas.width = side;
  canvas.height = side;

  ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
}

async function captureCurrentFace() {
  if (isBusy || currentFaceIndex >= FACE_ORDER.length) return;
  isBusy = true;
  updateButtons();

  const faceKey = currentFaceKey();
  setStatus(`Capturing ${faceKey}...`);

  try {
    const blob = await getSnapshotBlob();
    if (!blob) throw new Error("Unable to capture frame");

    const form = new FormData();
    form.append("file", blob, `${faceKey}.jpg`);
    form.append("expected_face", faceKey);
    if (Object.keys(colorCalibration).length > 0) {
      form.append("calibration_json", JSON.stringify(colorCalibration));
    }

    const res = await fetch("/api/detect-face", {
      method: "POST",
      body: form,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Detection failed");

    const grid = data.grid;
    if (!Array.isArray(grid) || grid.length !== 9) throw new Error("Invalid detection payload");
    renderAutogridInfo(data.autogrid || null);

    faces[faceKey] = grid;

    if (Array.isArray(data.center_hsv) && data.center_hsv.length === 3) {
      colorCalibration[FACE_CENTER_COLOR[faceKey]] = data.center_hsv;
    }

    renderFacePreviews();

    const center = grid[4];
    const expectedCenter = FACE_CENTER_COLOR[faceKey];
    if (center !== expectedCenter) {
      setStatus(
        `Captured ${faceKey}, but center detected ${center} (expected ${expectedCenter}). Move cube to center and retake.`,
        "bad"
      );
    } else {
      const suffix = data.center_corrected ? " (center auto-corrected)" : "";
      setStatus(`Captured ${faceKey} successfully${suffix}.`, "good");
      currentFaceIndex += 1;
    }

    updateStepInstruction();
    resultBox.innerHTML = "";
  } catch (err) {
    setStatus(`Capture error: ${err.message}`, "bad");
  } finally {
    isBusy = false;
    updateButtons();
  }
}

function retakePrevious() {
  if (isBusy || currentFaceIndex === 0) return;
  const prevIndex = currentFaceIndex - 1;
  const key = FACE_ORDER[prevIndex];
  delete faces[key];
  if (selectedSticker && selectedSticker.faceKey === key) {
    selectedSticker = null;
    updateCorrectionHelp();
    renderColorPicker();
  }
  currentFaceIndex = prevIndex;
  renderFacePreviews();
  updateStepInstruction();
  setStatus(`Retake enabled for ${key}.`);
  updateButtons();
}

async function finalizeState() {
  if (isBusy) return;
  isBusy = true;
  updateButtons();
  setStatus("Validating cube state...");

  try {
    const res = await fetch("/api/finalize-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faces }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Validation failed");

    if (data.is_solvable) {
      renderSolutionViewer(data.solution, data.cube_state);
      const extra = renderRotationRecoveryInfo(data);
      if (extra) {
        resultBox.innerHTML = `${extra}${resultBox.innerHTML}`;
      }
      setStatus("Validation complete.", "good");
    } else {
      resultBox.innerHTML = `
        <div class="bad"><strong>Cube is NOT solvable.</strong></div>
        <div>Reason: ${data.error || "Unknown"}</div>
        <div class="muted">Try recapturing with side references aligned, or correct stickers manually.</div>
      `;
      setStatus("Validation complete: unsolvable.", "bad");
    }
  } catch (err) {
    resultBox.innerHTML = `<div class="bad"><strong>Error:</strong> ${err.message}</div>`;
    setStatus(`Validation error: ${err.message}`, "bad");
  } finally {
    isBusy = false;
    updateButtons();
  }
}

startBtn.addEventListener("click", startCamera);
if (flipBtn) flipBtn.addEventListener("click", toggleVideoFlip);
if (autogridBtn) autogridBtn.addEventListener("click", toggleAutogrid);
captureBtn.addEventListener("click", captureCurrentFace);
retakeBtn.addEventListener("click", retakePrevious);
finalizeBtn.addEventListener("click", finalizeState);
if (demoBtn) demoBtn.addEventListener("click", loadDemoInput);
if (demoScrambleBtn) demoScrambleBtn.addEventListener("click", loadDemoScrambledInput);
if (clearBtn) clearBtn.addEventListener("click", clearAllInput);

window.addEventListener("keydown", (event) => {
  if (!stream) return;
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  event.preventDefault();
  captureCurrentFace();
});

updateStepInstruction();
updateButtons();
updateCorrectionHelp();
renderColorPicker();
renderProgressFaces();
renderOverlayReferences(currentFaceKey());
updateAutogridButton();
renderAutogridInfo();
