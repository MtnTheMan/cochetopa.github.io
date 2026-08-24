import { loadRenderAssets } from "./assets.js";
import { createAmbientVisualLayer } from "./ambient-visual-layer.js";
import { CAMERA_CYCLE, DENSITY_BANDS, ONEIDA_FIXTURE, cameraAtCycleSample } from "./fixture.js";
import { createInputController } from "./input.js";
import { createRenderer } from "./renderer.js";
import { representationCopy } from "./semantic-zoom.js";
import { createSyntheticHost } from "./synthetic-host.js";

const params = new URLSearchParams(location.search);
const densityBand = DENSITY_BANDS[params.get("density")] ? params.get("density") : "stand-cohorts";
const requestedView = ["close", "stand", "far"].includes(params.get("view")) ? params.get("view") : "stand";
const captureMode = params.get("capture") === "1";
const profileMode = captureMode && params.get("profile") === "1";
const viewToDensity = { close: "close-featured", stand: "stand-cohorts", far: "far-canopy-field" };
const initialCamera = DENSITY_BANDS[viewToDensity[requestedView]].camera;
const camera = { ...initialCamera };
const canvas = document.querySelector("#scene");
const rpTotal = document.querySelector("#rp-total");
const scaleLabel = document.querySelector("#scale-label");
const eventFeed = document.querySelector("#event-feed");
const profileReadout = document.querySelector("#profile-readout");
const feedbackOutput = document.querySelector("#local-feedback");
const live = document.querySelector("#app-live");
const seedingButton = document.querySelector("#seeding-mode");
const observeButton = document.querySelector("#observe-mode");
const idleDrift = document.querySelector("#idle-drift");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
if (reducedMotion.matches) { idleDrift.checked = false; idleDrift.disabled = true; }

const assets = await loadRenderAssets();
const host = createSyntheticHost({ densityBand });
const ambientVisualLayer = createAmbientVisualLayer({
  extent: ONEIDA_FIXTURE.extent,
  artBindings: assets.ambientArt?.manifest?.bindings || [],
  loadedFamilyIds: assets.ambientArt?.loadedFamilyIds || [],
});
const renderer = createRenderer(canvas, ONEIDA_FIXTURE, { assets, ambientVisualLayer, desynchronized: !captureMode });
let lastInputAt = performance.now();
let feedbackTimer = null;
let frameCount = 0;
let destroyed = false;

const input = createInputController({
  canvas, renderer, camera, getSnapshot: host.getSnapshot, dispatch: host.dispatch,
  onInput: () => { lastInputAt = performance.now(); }, onFeedback: showFeedback,
});

observeButton.addEventListener("click", () => setMode("observe"));
seedingButton.addEventListener("click", () => setMode(input.getMode() === "seeding" ? "observe" : "seeding"));
document.querySelectorAll("[data-camera]").forEach((button) => button.addEventListener("click", () => cameraAction(button.dataset.camera)));
idleDrift.addEventListener("change", () => { lastInputAt = performance.now(); live.textContent = idleDrift.checked ? "Gentle idle drift on" : "Gentle idle drift off"; });

function setMode(mode) {
  input.setMode(mode); const seeding = mode === "seeding";
  seedingButton.setAttribute("aria-pressed", String(seeding)); seedingButton.textContent = `Seeding: ${seeding ? "On" : "Off"}`;
  observeButton.setAttribute("aria-pressed", String(!seeding)); live.textContent = seeding ? "Seeding mode on" : "Observe and nurture mode";
}

function cameraAction(action) {
  input.cancel(); lastInputAt = performance.now();
  if (action === "zoom-in") camera.zoom = Math.min(320, camera.zoom * 1.35);
  if (action === "zoom-out") camera.zoom = Math.max(0.72, camera.zoom / 1.35);
  if (action === "rotate-left") camera.rotation -= Math.PI / 12;
  if (action === "rotate-right") camera.rotation += Math.PI / 12;
  if (action === "recenter") Object.assign(camera, DENSITY_BANDS[viewToDensity[requestedView]].camera);
}

function showFeedback(message) {
  feedbackOutput.textContent = message; feedbackOutput.dataset.visible = "true"; live.textContent = message;
  clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { feedbackOutput.dataset.visible = "false"; }, 1300);
}

function updateUi(snapshot, frame) {
  rpTotal.value = String(snapshot.rp); rpTotal.textContent = String(snapshot.rp);
  scaleLabel.textContent = representationCopy(frame.band).compact;
  eventFeed.replaceChildren(...snapshot.events.slice().sort((a, b) => b.order - a.order).slice(0, 4).map((event) => {
    const item = document.createElement("li"); item.dataset.tone = event.tone; item.textContent = event.message; return item;
  }));
  if (frameCount % 12 === 0) profileReadout.textContent = `${frame.band} · ${frame.durationMs.toFixed(2)} ms · ${frame.drawCalls} draws`;
}

function renderFrame(realNow) {
  if (destroyed) return;
  const presentationTime = captureMode ? 2400 : realNow;
  const renderCamera = { ...camera };
  if (!captureMode && idleDrift.checked && !reducedMotion.matches && realNow - lastInputAt > 4000) {
    renderCamera.rotation += Math.sin((realNow - lastInputAt - 4000) * 0.00008) * 0.055;
  }
  const snapshot = host.getSnapshot(presentationTime);
  const frame = renderer.render(snapshot, renderCamera, presentationTime);
  updateUi(snapshot, frame); frameCount += 1;
  window.__STAND_RENDERER__.lastFrame = frame;
  if (!captureMode) requestAnimationFrame(renderFrame);
  else {
    document.documentElement.dataset.ready = "true";
    if (profileMode) runCaptureProfile();
  }
}

function runCaptureProfile() {
  const snapshot = host.getSnapshot(2400);
  const samples = [];
  let priorBand = null;
  let lodTransitions = 0;
  let maxDrawCalls = 0;
  const maxVisible = {};
  for (let index = 0; index < CAMERA_CYCLE.sampleCount; index += 1) {
    const frame = renderer.render(snapshot, cameraAtCycleSample(index), index * (CAMERA_CYCLE.durationMs / (CAMERA_CYCLE.sampleCount - 1)));
    samples.push(frame.durationMs);
    if (priorBand && priorBand !== frame.band) lodTransitions += 1;
    priorBand = frame.band;
    maxDrawCalls = Math.max(maxDrawCalls, frame.drawCalls);
    for (const [key, value] of Object.entries(frame.visible)) maxVisible[key] = Math.max(maxVisible[key] || 0, value);
  }
  const sorted = samples.slice().sort((left, right) => left - right);
  const report = {
    schema: "stand-browser-frame-profile@1",
    fixtureId: ONEIDA_FIXTURE.id,
    snapshotRevision: snapshot.revision,
    ecologicalStateChanged: snapshot !== host.getSnapshot(2400),
    cameraCycleId: CAMERA_CYCLE.id,
    frameCount: samples.length,
    p50FrameMs: percentile(sorted, 0.5),
    p95FrameMs: percentile(sorted, 0.95),
    p99FrameMs: percentile(sorted, 0.99),
    renderSamplesOver50Ms: samples.filter((value) => value > 50).length,
    lodTransitions,
    maxDrawCalls,
    maxVisible,
    memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null,
    ambientVisualReplay: renderer.getLastFrame().ambientVisualLayer,
    measurementScope: "Synchronous Canvas render cost in local headless Chromium; excludes compositor/GPU presentation and system-wide long-task attribution.",
  };
  const evidence = document.createElement("script");
  evidence.id = "browser-profile-json"; evidence.type = "application/json"; evidence.textContent = JSON.stringify(report);
  document.body.append(evidence); document.documentElement.dataset.profileReady = "true";
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))];
}

window.__STAND_RENDERER__ = {
  schema: "stand-render-runner@1", fixtureId: ONEIDA_FIXTURE.id, densityBand, requestedView,
  ambientVisualLayer,
  camera, get snapshot() { return host.getSnapshot(captureMode ? 2400 : performance.now()); },
  lastFrame: null,
  renderAt(timeMs, nextCamera = camera) { const frame = renderer.render(host.getSnapshot(timeMs), nextCamera, timeMs); this.lastFrame = frame; return frame; },
};

addEventListener("beforeunload", () => { destroyed = true; input.destroy(); renderer.destroy(); });
setMode("observe");
requestAnimationFrame(renderFrame);
