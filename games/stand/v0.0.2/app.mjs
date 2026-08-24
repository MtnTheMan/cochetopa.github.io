import { createVerticalAssembly, validateSaveEnvelope } from "./prototypes/alpha-1/vertical-slice/assembly.mjs";
import { runScriptedPlay } from "./prototypes/alpha-1/vertical-slice/scripted-play.mjs";
import { createRenderFixture } from "./prototypes/alpha-1/vertical-slice/world-view.mjs";
import { createAmbientVisualLayer } from "./prototypes/alpha-1/renderer-spike/src/ambient-visual-layer.js";
import { loadRenderAssets } from "./prototypes/alpha-1/renderer-spike/src/assets.js";
import { createRenderer } from "./prototypes/alpha-1/renderer-spike/src/renderer.js";
import { representationCopy } from "./prototypes/alpha-1/renderer-spike/src/semantic-zoom.js";
import { bindElements } from "./dom-elements.mjs";
import { createActiveTimeLoop } from "./active-time.mjs";
import { canonicalStringify } from "./src/spine/canonical-json.mjs";
import { createPlatformHost } from "./platform-host.mjs";

const platform = createPlatformHost();
const elements = bindElements(document);
const buttons = Array.from(document.querySelectorAll("button"));
const bootOptions = await platform.bootOptions();
const identities = await fetchJson("./prototypes/alpha-1/vertical-slice/identities.json");
const worldView = bootOptions.testMode
  ? await fetchJson("./data/fixtures/world/oneida-v0.0.2/sugar-maple-runtime-diagnostic-v1.json")
  : bootOptions.cacheConfigured
    ? await platform.loadExternalWorldView()
    : await fetchHashBoundJson("./data/runtime/oneida-vertical-runtime-view-v1.json", identities.world.viewSha256);
const storage = platform.storage(bootOptions.smokeRequested ? "smoke" : "main");
const assets = await loadRenderAssets();
const normalizedWorldView = bootOptions.testMode ? normalizeTestView(worldView) : worldView;
const renderFixture = createRenderFixture(normalizedWorldView);
const selected = normalizedWorldView.sitePreview.find((site) => site.hex_id === normalizedWorldView.selectedFounderSiteId);
const artBindings = assets.ambientArt?.manifest?.bindings ?? [];
const ambientVisualLayer = createAmbientVisualLayer({
  extent: renderFixture.extent,
  localFocus: { x: selected.viewX, y: selected.viewY },
  artBindings,
  loadedFamilyIds: assets.ambientArt?.loadedFamilyIds ?? [],
});
const renderer = createRenderer(elements.scene, renderFixture, { assets, ambientVisualLayer });
const cameras = {
  close: { centerX: selected.viewX, centerY: selected.viewY, zoom: 220, rotation: -0.16 },
  stand: { centerX: selected.viewX, centerY: selected.viewY, zoom: 28, rotation: 0.18 },
  far: { centerX: renderFixture.extent.width / 2, centerY: renderFixture.extent.height / 2, zoom: 0.88, rotation: 0 },
};
const camera = { ...cameras.stand };
const idPrefix = platform.kind === "browser" ? "browser" : "desktop";
let assembly = await createVerticalAssembly({ worldView, identities, storage, testMode: bootOptions.testMode, masterSeed: 0x51a70002, idPrefix });
let snapshot;
let pointer = null;
let serviceTimer = null;
let renderRequested = false;
let busy = false;
const activeTime = createActiveTimeLoop({
  getState: () => assembly.getGameplayView(),
  advance: advanceActiveTime,
});

try {
  if (bootOptions.smokeRequested) {
    await runPackagedSmoke();
  } else {
    const loaded = await assembly.load();
    if (!loaded) await assembly.startNew();
    setStatus(loaded ? restoredStatus(loaded) : "Founder samara landed at ½× in the real Oneida Working site view.");
    bindInput();
    activeTime.start();
    refresh();
  }
} catch (error) {
  setStatus(error instanceof Error ? error.message : String(error), "error");
  setBusy(true);
}

async function runPackagedSmoke() {
  setBusy(true);
  const bootReceipt = await assembly.load();
  const bootChecksum = bootReceipt ? assembly.checksum() : null;
  assembly = await createVerticalAssembly({ worldView, identities, storage, masterSeed: 0x51a70002, idPrefix });
  const trace = await runScriptedPlay(assembly);
  snapshot = assembly.snapshotView();
  const frames = ["close", "stand", "far"].map((band) => renderer.render(snapshot, cameras[band], 40_000));
  const authoritativeChecksum = assembly.checksum();
  const saveReceipt = await assembly.save();
  const restarted = await createVerticalAssembly({ worldView, identities, storage, masterSeed: 999, idPrefix: "restart" });
  const loadReceipt = await restarted.load();
  const replay = await createVerticalAssembly({ worldView, identities, masterSeed: 0x51a70002, idPrefix });
  const replayTrace = await runScriptedPlay(replay);
  const evidence = {
    resultVersion: 1,
    scenarioId: "VERTICAL-REAL-ONEIDA-SMOKE@1",
    worldManifestSha256: identities.world.manifestSha256,
    worldSiteStateSha256: identities.world.siteStateSha256,
    authoritativeChecksum,
    loadedExistingAtBoot: Boolean(bootReceipt),
    bootRestoreMatchesTrace: bootChecksum === null || bootChecksum === authoritativeChecksum,
    exactRestore: Boolean(loadReceipt) && restarted.checksum() === authoritativeChecksum,
    deterministicReplay: replay.checksum() === authoritativeChecksum && JSON.stringify(replayTrace) === JSON.stringify(trace),
    protectedOfflineAtBoot: bootReceipt?.offlineDigest ?? null,
    saveGeneration: saveReceipt.generation,
    trace,
    renderBands: frames.map(({ band }) => band),
    ambientFamilyCount: ambientVisualLayer.loadedRuntimeAssetCoverage,
  };
  setStatus(`Packaged Vertical smoke saved generation ${saveReceipt.generation}.`);
  await platform.completeVerticalSmoke(evidence);
}

function bindInput() {
  elements.observeMode.addEventListener("click", () => setMode("observe"));
  elements.seedingMode.addEventListener("click", () => setMode(assembly.getGameplayView().mode === "seeding" ? "observe" : "seeding"));
  elements.tick.addEventListener("click", () => perform(async () => { await assembly.tick(1); showFeedback("Forest time advanced one Working reference year"); }));
  elements.pause.addEventListener("click", () => setPaused(!assembly.getGameplayView().paused));
  document.querySelectorAll("[data-speed]").forEach((button) => button.addEventListener("click", () => setSpeed(Number(button.dataset.speed))));
  elements.save.addEventListener("click", () => perform(async () => { const receipt = await assembly.save(); setStatus(savedStatus(receipt)); }));
  elements.reload.addEventListener("click", () => perform(async () => { const receipt = await assembly.load(); setStatus(receipt ? restoredStatus(receipt, "Reloaded") : "No valid save exists."); }));
  elements.browserSaveTools.hidden = platform.kind !== "browser";
  elements.webVersionNav.hidden = platform.kind !== "browser";
  elements.exportSave.addEventListener("click", () => perform(exportBrowserSave));
  elements.importSave.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", () => perform(importBrowserSave));
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { Object.assign(camera, cameras[button.dataset.view]); refresh(); }));
  elements.rotateLeft.addEventListener("click", () => rotateCamera(-Math.PI / 12));
  elements.rotateRight.addEventListener("click", () => rotateCamera(Math.PI / 12));
  elements.recenter.addEventListener("click", () => { Object.assign(camera, cameras.stand); refresh(); elements.scene.focus(); });
  elements.reducedMotion.checked = matchMedia("(prefers-reduced-motion: reduce)").matches;
  elements.reducedMotion.addEventListener("change", () => perform(() => assembly.dispatch({ type: "settings/update", settings: { reducedMotion: elements.reducedMotion.checked, cameraIdleDrift: false } })));
  elements.scene.addEventListener("pointerdown", pointerDown);
  elements.scene.addEventListener("pointermove", pointerMove);
  elements.scene.addEventListener("pointerup", pointerUp);
  elements.scene.addEventListener("pointercancel", pointerCancel);
  elements.scene.addEventListener("lostpointercapture", pointerCancel);
  elements.scene.addEventListener("wheel", wheel, { passive: false });
  elements.scene.addEventListener("keydown", keyDown);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      activeTime.stop();
      void perform(async () => { await assembly.dispatch({ type: "lifecycle/hidden" }); await assembly.save(); });
    } else activeTime.start();
  });
  addEventListener("blur", () => void assembly.dispatch({ type: "lifecycle/blur" }));
  addEventListener("resize", refresh);
}

function pointerDown(event) {
  if (busy || (event.button !== undefined && event.button !== 0)) return;
  const point = localPoint(event);
  const current = snapshot ?? assembly.snapshotView();
  const mode = assembly.getGameplayView().mode;
  if (mode === "seeding") {
    const clickedWorld = renderer.screenToWorld(point.x, point.y, camera);
    const source = nearestSeedSource(clickedWorld, current);
    if (!source) {
      showFeedback("No reproductive managed sugar maple can release seed yet");
      return;
    }
    pointer = {
      id: event.pointerId, device: device(event), kind: "seed-aim", sourceId: source.id,
      sourceWorld: { x: source.x, y: source.y }, targetWorld: clickedWorld,
      sourceScreen: renderer.worldToScreen(source.x, source.y, camera), start: point, last: point, startedSeed: false,
    };
    elements.scene.setPointerCapture?.(event.pointerId);
    refresh();
  } else {
    pointer = { id: event.pointerId, device: device(event), last: point };
    elements.scene.setPointerCapture?.(event.pointerId);
    const target = renderer.hitTest(point.x, point.y, current, camera);
    const hit = target ? { entityId: target.id, entityType: "tree", speciesId: target.speciesId, managed: target.relationship === "managed", living: target.state === "living", locationRef: { presentationX: target.x, presentationY: target.y }, localSun: .7, localWater: .65 } : null;
    if (!hit) {
      pointer.kind = "camera";
      pointer.anchorWorld = renderer.screenToWorld(point.x, point.y, camera);
      pointer.startCamera = { centerX: camera.centerX, centerY: camera.centerY };
    }
    void perform(() => assembly.dispatch({ type: "pointer/down", pointerId: event.pointerId, pointerCount: 1, device: pointer.device, at: performance.now(), position: point, hit }));
  }
  event.preventDefault();
}

function pointerMove(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const point = localPoint(event); pointer.last = point;
  if (pointer.kind === "camera") {
    const startView = { ...camera, centerX: pointer.startCamera.centerX, centerY: pointer.startCamera.centerY };
    const currentWorld = renderer.screenToWorld(point.x, point.y, startView);
    camera.centerX = pointer.startCamera.centerX + pointer.anchorWorld.x - currentWorld.x;
    camera.centerY = pointer.startCamera.centerY + pointer.anchorWorld.y - currentWorld.y;
    refresh();
  } else if (pointer.kind === "seed-aim") {
    pointer.targetWorld = renderer.screenToWorld(point.x, point.y, camera);
    const dragDistance = Math.hypot(point.x - pointer.start.x, point.y - pointer.start.y);
    const sourceDistance = Math.max(1e-9, Math.hypot(
      pointer.targetWorld.x - pointer.sourceWorld.x,
      pointer.targetWorld.y - pointer.sourceWorld.y,
    ));
    if (dragDistance >= 12) {
      const direction = standDirection(
        (pointer.targetWorld.x - pointer.sourceWorld.x) / sourceDistance,
        (pointer.targetWorld.y - pointer.sourceWorld.y) / sourceDistance,
      );
      const action = {
        type: pointer.startedSeed ? "pointer/move" : "pointer/down", pointerId: event.pointerId, at: performance.now(),
        domainPosition: standPosition(pointer.targetWorld), domainDirection: direction,
      };
      if (!pointer.startedSeed) {
        pointer.startedSeed = true; action.pointerCount = 1; action.device = pointer.device; action.sourceTreeId = pointer.sourceId;
        serviceTimer = setInterval(() => void perform(() => assembly.dispatch({ type: "input/service", at: performance.now() })), 32);
      }
      void perform(() => assembly.dispatch(action));
    }
    refresh();
  } else void perform(() => assembly.dispatch({ type: "pointer/move", pointerId: event.pointerId, at: performance.now(), position: point }));
  event.preventDefault();
}

function pointerUp(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const finished = pointer; clearInterval(serviceTimer); serviceTimer = null; pointer = null;
  if (finished.kind === "seed-aim" && !finished.startedSeed) showFeedback("Drag on the map to aim the nearest reproductive sugar maple");
  else void perform(() => assembly.dispatch({ type: "pointer/up", pointerId: event.pointerId, device: finished.device, at: performance.now(), position: finished.last }));
  refresh(); event.preventDefault();
}
function pointerCancel(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const cancelled = pointer; clearInterval(serviceTimer); serviceTimer = null; pointer = null;
  if (cancelled.kind !== "seed-aim" || cancelled.startedSeed) void perform(() => assembly.dispatch({ type: "pointer/cancel", pointerId: event.pointerId }));
  refresh();
}
function wheel(event) { Object.assign(camera, { zoom: Math.max(.72, Math.min(320, camera.zoom * Math.exp(-event.deltaY * .0018))) }); void assembly.dispatch({ type: "camera/wheel", delta: event.deltaY }); refresh(); event.preventDefault(); }
function setMode(mode) { void perform(() => assembly.dispatch({ type: "mode/set", mode })); }

function setSpeed(speed) {
  void perform(async () => {
    await assembly.dispatch({ type: "time/set-speed", speed });
    await assembly.dispatch({ type: "time/set-paused", paused: false });
    activeTime.reschedule();
  });
}

function setPaused(paused) {
  void perform(async () => {
    await assembly.dispatch({ type: "time/set-paused", paused });
    activeTime.reschedule();
  });
}

function rotateCamera(delta) {
  camera.rotation = normalizeAngle(camera.rotation + delta);
  void assembly.dispatch({ type: "camera/rotate-start" });
  refresh();
  elements.scene.focus();
}

function keyDown(event) {
  const key = event.key.toLowerCase();
  let handled = true;
  if (event.key === "ArrowLeft" || key === "a") panCamera(-64, 0);
  else if (event.key === "ArrowRight" || key === "d") panCamera(64, 0);
  else if (event.key === "ArrowUp" || key === "w") panCamera(0, -64);
  else if (event.key === "ArrowDown" || key === "s") panCamera(0, 64);
  else if (event.key === "+" || event.key === "=") camera.zoom = Math.min(320, camera.zoom * 1.35);
  else if (event.key === "-" || event.key === "_") camera.zoom = Math.max(.72, camera.zoom / 1.35);
  else if (event.key === "[" || key === "q") rotateCamera(-Math.PI / 12);
  else if (event.key === "]" || key === "e") rotateCamera(Math.PI / 12);
  else if (event.code === "Space" && !event.repeat) setMode(assembly.getGameplayView().mode === "seeding" ? "observe" : "seeding");
  else if (event.key === "0") Object.assign(camera, cameras.stand);
  else handled = false;
  if (handled) { refresh(); event.preventDefault(); }
}

function panCamera(screenDx, screenDy) {
  const rect = elements.scene.getBoundingClientRect();
  const center = { x: rect.width / 2, y: rect.height / 2 };
  const from = renderer.screenToWorld(center.x, center.y, camera);
  const to = renderer.screenToWorld(center.x + screenDx, center.y + screenDy, camera);
  camera.centerX += to.x - from.x; camera.centerY += to.y - from.y;
}

async function advanceActiveTime(steps, presentedAt) {
  if (busy || document.hidden) return;
  busy = true;
  try {
    await assembly.tick(steps, presentedAt);
    refresh();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    busy = false;
  }
}

async function perform(work) {
  if (busy) return;
  busy = true; setBusy(true);
  try { await work(); refresh(); }
  catch (error) { setStatus(error instanceof Error ? error.message : String(error), "error"); }
  finally { busy = false; setBusy(false); }
}

function refresh() {
  snapshot = assembly.snapshotView();
  if (renderRequested) return;
  renderRequested = true;
  requestAnimationFrame((time) => {
    renderRequested = false;
    let renderSnapshot = snapshot;
    if (pointer?.kind === "seed-aim") {
      const distance = Math.hypot(pointer.last.x - pointer.start.x, pointer.last.y - pointer.start.y);
      renderSnapshot = { ...snapshot, feedback: [...(snapshot.feedback || []), {
        id: "seed-aim", type: "seed-aim", sourceX: pointer.sourceWorld.x, sourceY: pointer.sourceWorld.y,
        targetX: pointer.targetWorld.x, targetY: pointer.targetWorld.y, ready: distance >= 12,
      }] };
    }
    const frame = renderer.render(renderSnapshot, camera, time);
    const gameplay = assembly.getGameplayView();
    elements.rpTotal.textContent = String(snapshot.rp);
    elements.rpDelta.textContent = gameplay.rpDelta ? `+${gameplay.rpDelta.amount}` : "";
    elements.forestYear.textContent = String(snapshot.forestTimeYears);
    elements.timeState.textContent = gameplay.paused ? "Paused" : formatTimeSpeed(gameplay.timeSpeed);
    elements.pause.setAttribute("aria-pressed", String(gameplay.paused));
    elements.pause.textContent = gameplay.paused ? "Resume" : "Pause";
    document.querySelectorAll("[data-speed]").forEach((button) => button.setAttribute("aria-pressed", String(!gameplay.paused && Number(button.dataset.speed) === gameplay.timeSpeed)));
    elements.scaleLabel.textContent = representationCopy(frame.band).compact;
    elements.siteFactor.textContent = bootOptions.testMode ? "Synthetic test fixture · not real Oneida" : worldView.siteFactor.label;
    elements.sourceLabel.textContent = renderFixture.sourceCopy.detail;
    elements.eventFeed.replaceChildren(...gameplay.feed.slice(0, 4).map((row) => { const item = document.createElement("li"); item.textContent = `${row.text}${row.count > 1 ? ` ×${row.count}` : ""}`; return item; }));
    const seeding = gameplay.mode === "seeding";
    elements.seedingMode.setAttribute("aria-pressed", String(seeding)); elements.seedingMode.textContent = `Seeding: ${seeding ? "On" : "Off"}`;
    elements.observeMode.setAttribute("aria-pressed", String(!seeding));
    if (gameplay.localFeedback) showFeedback(gameplay.localFeedback.kind.replaceAll("-", " "));
    if (!elements.reducedMotion.checked && snapshot.seeds.some((seed) => time - seed.presentationBornAtMs < 2200)) refresh();
  });
}

function restoredStatus(receipt, verb = "Restored") {
  const generationKind = platform.kind === "browser" ? "browser generation" : "atomic generation";
  const offline = receipt.offlineDigest;
  if (offline?.elapsedDaysApplied > 0) {
    const discarded = offline.elapsedDaysDiscardedBySafetyCap > 0 ? `; ${offline.elapsedDaysDiscardedBySafetyCap} excess days safely discarded` : "";
    return `${verb} ${generationKind} ${receipt.generation}; applied ${offline.elapsedDaysApplied} protected offline day${offline.elapsedDaysApplied === 1 ? "" : "s"}${discarded}.`;
  }
  if (offline?.status === "backward_clock_held_no_advancement") return `${verb} ${generationKind} ${receipt.generation}; backward clock detected, so no offline advancement was applied.`;
  return `${verb} ${generationKind} ${receipt.generation}.`;
}
function savedStatus(receipt) { return `Saved ${platform.kind === "browser" ? "browser" : "atomic"} generation ${receipt.generation}.`; }

async function exportBrowserSave() {
  if (platform.kind !== "browser") return;
  const [latest] = await storage.load();
  if (!latest) { setStatus("No browser save exists to export."); return; }
  const blob = new Blob([latest.canonicalPayload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stand-v0.0.2-save-g${String(latest.generation).padStart(8, "0")}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(`Exported browser generation ${latest.generation}.`);
}

async function importBrowserSave() {
  const [file] = elements.importFile.files ?? [];
  elements.importFile.value = "";
  if (!file || platform.kind !== "browser") return;
  const parsed = JSON.parse(await file.text());
  const normalized = validateSaveEnvelope(parsed, identities, worldView, { migrationUnixMs: Date.now() });
  const receipt = await storage.save(canonicalStringify(normalized));
  const loaded = await assembly.load();
  if (!loaded || loaded.generation !== receipt.generation) throw new Error("Imported Stand save could not be restored exactly.");
  setStatus(`Imported and restored browser generation ${receipt.generation}.`);
}
function setBusy(value) { buttons.forEach((button) => { button.disabled = value; }); }
function setStatus(message, kind = "info") { elements.status.textContent = message; elements.status.dataset.kind = kind; }
function showFeedback(message) { elements.localFeedback.textContent = message; elements.localFeedback.dataset.visible = "true"; clearTimeout(showFeedback.timer); showFeedback.timer = setTimeout(() => { elements.localFeedback.dataset.visible = "false"; }, 1300); }
function nearestSeedSource(point, current) {
  return (current.individuals || [])
    .filter((entity) => entity.relationship === "managed" && entity.state === "living" && entity.seedSourceEligible)
    .sort((left, right) => {
      const distance = Math.hypot(left.x - point.x, left.y - point.y) - Math.hypot(right.x - point.x, right.y - point.y);
      return distance || String(left.id).localeCompare(String(right.id));
    })[0] ?? null;
}
function localPoint(event) { const rect = elements.scene.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
function device(event) { return ["mouse", "touch", "pen"].includes(event.pointerType) ? event.pointerType : "mouse"; }
function standPosition(point) { return { contract: "STAND-POSITION@1", frameId: "stand-local-unitless", unit: "micrometre", x: Math.round(point.x * 1_000_000), y: Math.round(point.y * 1_000_000) }; }
function standDirection(x, y) { return { contract: "STAND-DIRECTION@1", frameId: "stand-local-unitless", unit: "unit-vector", x, y }; }
function normalizeAngle(value) { return Math.atan2(Math.sin(value), Math.cos(value)); }
function formatTimeSpeed(speed) { return speed === 0.5 ? "½×" : `${speed}×`; }
async function fetchJson(url) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`Packaged payload load failed: ${response.status}`); return response.json(); }
async function fetchHashBoundJson(url, expectedSha256) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Packaged Oneida view load failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
  if (digest !== expectedSha256) throw new Error("Packaged Oneida view SHA-256 disagrees with the reviewed identity.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
function normalizeTestView(candidate) {
  const sites = candidate.sites.map((site, index) => ({ ...site, viewX: 42 + index * 28, viewY: 46, workingSiteFactor01: index === 0 ? .83 : .24 }));
  const samples = sites.map((site) => ({ viewX: site.viewX, viewY: site.viewY, workingSiteFactor01: site.workingSiteFactor01, elevationM: Number(site.elevation_m_mean) || 0 }));
  return {
    sourcePackage: { manifestSha256: "synthetic-test-fixture" }, sitePreview: sites, selectedFounderSiteId: sites[0].hex_id,
    countyPreview: {
      extent: { width: 120, height: 92 },
      boundary: { sourceSha256: "synthetic", points: [[4, 4], [116, 4], [116, 88], [4, 88]] },
      siteSamples: samples,
    },
  };
}
