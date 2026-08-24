export const ZOOM_THRESHOLDS = Object.freeze({
  farToStand: 4,
  standToFar: 2.8,
  standToClose: 80,
  closeToStand: 60,
});

export function semanticWeights(zoom) {
  const value = clamp(Number(zoom) || 1, 0.72, 320);
  const logValue = Math.log(value);
  const far = 1 - smoothstep((logValue - Math.log(1.2)) / (Math.log(8) - Math.log(1.2)));
  const close = smoothstep((logValue - Math.log(35)) / (Math.log(130) - Math.log(35)));
  const stand = Math.max(0, 1 - far - close);
  const total = far + stand + close || 1;
  return { far: far / total, stand: stand / total, close: close / total };
}

export function nextSemanticBand(previous, zoom) {
  const value = Number(zoom) || 1;
  if (previous === "close") return value < ZOOM_THRESHOLDS.closeToStand ? "stand" : "close";
  if (previous === "far") return value > ZOOM_THRESHOLDS.farToStand ? "stand" : "far";
  if (value >= ZOOM_THRESHOLDS.standToClose) return "close";
  if (value <= ZOOM_THRESHOLDS.standToFar) return "far";
  return "stand";
}

export function representationCopy(band) {
  if (band === "close") return {
    compact: "Close featured-tree representation",
    accessible: "Close individual-tree representation inside the playable Oneida landscape.",
  };
  if (band === "far") return {
    compact: "Oneida County overview · Working site field",
    accessible: "Direct-overhead Oneida County view of county-spanning Working sugar-maple state, not fitted suitability or calibrated production ecology.",
  };
  return {
    compact: "Stand representation",
    accessible: "Managed stand representation within the wider playable Oneida County landscape.",
  };
}

function smoothstep(value) { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
