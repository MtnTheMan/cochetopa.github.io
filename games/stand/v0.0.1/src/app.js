import {
  SPECIES,
  createSyntheticWorld,
  getCell,
  suitabilityAt,
} from "./data/world.js";
import {
  FOUNDER_MIN_SUITABILITY,
  SIMULATION_RULES,
  createSimulation,
  disperseFromGesture,
  nurtureFounder,
  placeFounder,
  restoreSimulation,
  setTimeSpeed,
  snapshotSimulation,
  stepSimulation,
} from "./sim/engine.js";
import { createRenderer } from "./render/renderer.js";
import { createInterface } from "./ui/interface.js";
import { canDisperse } from "./interaction/mode.js";

const BUILD_VERSION = "0.0.1";
const SAVE_SCHEMA_VERSION = 1;
const SAVE_KEY = "stand.alpha-0.save.v1";
const WORLD_SEED = 20260803;
const SIMULATION_SEED = 20260803;
const WORLD_WIDTH = 72;
const WORLD_HEIGHT = 54;
const CONTROLLED_SPECIES_ID = "acer-saccharum";
const BASE_YEARS_PER_REAL_SECOND = 0.08;
const FIXED_REAL_STEP_SECONDS = 1 / 30;
const MAX_FRAME_SECONDS = 0.2;
const MAX_CATCH_UP_STEPS = 8;
const POINTER_DRAG_THRESHOLD = 7;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 16;

const canvas = document.querySelector("#world-canvas");
const interfaceRoot = document.querySelector("#interface-root");
const cameraControls = document.querySelector("#camera-controls");
const bootStatus = document.querySelector("#boot-status");
const bootMessage = document.querySelector("[data-boot-message]");
const appLive = document.querySelector("#app-live");

window.addEventListener("error", (event) => {
  if (bootStatus && !bootStatus.hidden) {
    reportBootError(event.error || new Error(event.message));
  }
});

if (!canvas || !interfaceRoot || !cameraControls || !bootStatus || !bootMessage) {
  throw new Error("Stand alpha could not find its required page elements.");
}

let world = createWorld();
let simulation = createFreshSimulation();
let renderer = createRenderer(canvas, world, { suitabilityVisible: true });
let selectedSpeciesId = null;
let phase = "species-selection";
let paused = false;
let seedingMode = false;
let suitabilityVisible = true;
let lastFrameMs = null;
let realAccumulator = 0;
let destroyed = false;
let eventSerial = 1;
let ephemeralEvents = [];
let primaryGesture = null;
let pinchGesture = null;
const activePointers = new Map();

const view = {
  centerX: world.width / 2,
  centerY: world.height / 2,
  zoom: 1,
  rotation: -0.08,
  selectedCell: null,
  hoverCell: null,
  mode: "observe",
};

const ui = createInterface(interfaceRoot, {
  onSpeciesChosen: chooseSpecies,
  onPlantMode: toggleSeedingMode,
  onTimeSpeed: changeTimeSpeed,
  onPause: togglePause,
  onSave: saveGame,
  onLoad: loadGame,
  onSuitabilityToggle: setSuitabilityVisibility,
  onReset: resetGame,
});

installInputHandlers();
syncAll();
ui.showSpeciesSelection(SPECIES[CONTROLLED_SPECIES_ID]);
finishBoot();
requestAnimationFrame(frame);

globalThis.__STAND_ALPHA__ = Object.freeze({
  version: BUILD_VERSION,
  saveSchemaVersion: SAVE_SCHEMA_VERSION,
  getWorld: () => world,
  getState: () => snapshotSimulation(simulation),
  getView: () => ({ ...view }),
  getMode: () => ({
    phase,
    paused,
    seedingMode,
    suitabilityVisible,
  }),
  save: saveGame,
  load: loadGame,
  reset: resetGame,
});

function createWorld(options = {}) {
  return createSyntheticWorld({
    width: options.width ?? WORLD_WIDTH,
    height: options.height ?? WORLD_HEIGHT,
    seed: options.seed ?? WORLD_SEED,
  });
}

function createFreshSimulation() {
  return createSimulation({
    seed: SIMULATION_SEED,
    speed: 1,
    speciesId: CONTROLLED_SPECIES_ID,
  });
}

function chooseSpecies(speciesId) {
  if (!Object.hasOwn(SPECIES, speciesId)) {
    ui.announce("That species is not available in this alpha.", "caution");
    return;
  }

  selectedSpeciesId = speciesId;
  phase = "site-selection";
  paused = false;
  seedingMode = false;
  setTimeSpeed(simulation, 1);
  view.mode = "inspect";
  view.centerX = world.width / 2;
  view.centerY = world.height / 2;
  view.zoom = 1;
  view.selectedCell = null;
  ui.showStartGuidance();
  ui.announce(
    "Choose a promising part of the suitability wash for the founding samara.",
    "calm",
  );
  syncAll();
}

function toggleSeedingMode() {
  if (seedingMode) {
    seedingMode = false;
    ui.announce("Seeding mode off. Returning to passive Observe and Nurture.", "calm");
    syncAll();
    return;
  }

  if (phase !== "play") {
    ui.announce("Let the founding tree establish before dispersing more samaras.", "calm");
    return;
  }
  if (!hasReproductiveSource()) {
    ui.announce(
      "The founding tree needs a little more growth before it can release samaras.",
      "calm",
    );
    return;
  }

  seedingMode = true;
  ui.announce(
    "Seeding mode on. Click for one samara or drag outward for a loose dispersal cloud.",
    "success",
  );
  syncAll();
}

function changeTimeSpeed(speed) {
  if (phase === "founder-landing") {
    ui.announce("The founding samara lands at 1x. Faster time unlocks afterward.", "calm");
    setTimeSpeed(simulation, 1);
    syncAll();
    return;
  }
  if (phase === "species-selection" || phase === "site-selection") {
    ui.announce("Choose the founding location before changing forest time.", "calm");
    return;
  }

  try {
    setTimeSpeed(simulation, speed);
    paused = false;
    ui.announce("Forest time is now " + speed + "x.", "calm");
    syncAll();
  } catch {
    ui.announce("That time speed is not available.", "caution");
  }
}

function togglePause() {
  if (simulation.founderId === null) {
    ui.announce("Forest time begins after the founding samara is placed.", "calm");
    return;
  }
  paused = !paused;
  ui.announce(paused ? "Forest time paused." : "Forest time resumed.", "calm");
  syncAll();
}

function setSuitabilityVisibility(visible) {
  suitabilityVisible = Boolean(visible);
  renderer.setSuitabilityVisible(suitabilityVisible);
  ui.announce(
    suitabilityVisible
      ? "Suitability wash shown."
      : "Suitability wash hidden.",
    "calm",
  );
  syncAll();
}

function saveGame() {
  const payload = {
    version: SAVE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    world: {
      version: world.version,
      seed: world.seed,
      width: world.width,
      height: world.height,
      region: world.region,
    },
    simulation: snapshotSimulation(simulation),
    session: {
      selectedSpeciesId,
      phase,
      paused,
      seedingMode,
      suitabilityVisible,
    },
    view: sanitizeView(view, world),
  };

  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    ui.announce("This forest has been saved in the current browser.", "success");
    syncAll();
    return true;
  } catch {
    ui.announce(
      "The browser could not save this forest. The running stand is unchanged.",
      "caution",
    );
    return false;
  }
}

function loadGame() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    ui.announce("The browser could not read local saves.", "caution");
    return false;
  }

  if (!raw) {
    ui.announce("No Stand alpha save is available in this browser yet.", "calm");
    return false;
  }

  try {
    const payload = JSON.parse(raw);
    const restored = validateSave(payload);
    const nextWorld = createWorld(restored.world);
    const nextSimulation = restoreSimulation(restored.simulation);
    const nextView = sanitizeView(restored.view, nextWorld);
    const nextPhase = derivePhase(
      nextSimulation,
      restored.session.selectedSpeciesId,
      restored.session.phase,
    );

    const previousRenderer = renderer;
    renderer = createRenderer(canvas, nextWorld, {
      suitabilityVisible: restored.session.suitabilityVisible,
    });
    world = nextWorld;
    simulation = nextSimulation;
    Object.assign(view, nextView);
    selectedSpeciesId = restored.session.selectedSpeciesId;
    phase = nextPhase;
    paused = Boolean(restored.session.paused);
    suitabilityVisible = Boolean(restored.session.suitabilityVisible);
    seedingMode =
      nextPhase === "play" &&
      Boolean(restored.session.seedingMode) &&
      hasReproductiveSource();
    if (phase === "founder-landing") {
      setTimeSpeed(simulation, 1);
    }
    renderer.setSuitabilityVisible(suitabilityVisible);
    previousRenderer.destroy();

    primaryGesture = null;
    pinchGesture = null;
    activePointers.clear();
    ephemeralEvents = [];
    lastFrameMs = null;
    realAccumulator = 0;
    syncOnboarding();
    syncAll();
    ui.announce("The saved forest has returned.", "success");
    return true;
  } catch {
    ui.announce(
      "That save is missing or incompatible. The running forest is unchanged.",
      "caution",
    );
    return false;
  }
}

function validateSave(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.version !== SAVE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported save version.");
  }
  if (!payload.world || !payload.simulation || !payload.session || !payload.view) {
    throw new Error("Incomplete save.");
  }
  const width = Number(payload.world.width);
  const height = Number(payload.world.height);
  const seed = Number(payload.world.seed);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 24 ||
    height < 18 ||
    width > 180 ||
    height > 140 ||
    !Number.isSafeInteger(seed)
  ) {
    throw new Error("Invalid world metadata.");
  }
  if (
    payload.session.selectedSpeciesId !== null &&
    !Object.hasOwn(SPECIES, payload.session.selectedSpeciesId)
  ) {
    throw new Error("Unsupported species.");
  }
  if (
    payload.session.selectedSpeciesId === null &&
    payload.simulation.founderId !== null
  ) {
    throw new Error("A founding tree requires a selected species.");
  }
  return {
    world: { width, height, seed },
    simulation: payload.simulation,
    session: payload.session,
    view: payload.view,
  };
}

function resetGame() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // Resetting the live prototype remains safe even when storage is blocked.
  }

  renderer.destroy();
  world = createWorld();
  simulation = createFreshSimulation();
  renderer = createRenderer(canvas, world, { suitabilityVisible: true });
  selectedSpeciesId = null;
  phase = "species-selection";
  paused = false;
  seedingMode = false;
  suitabilityVisible = true;
  Object.assign(view, {
    centerX: world.width / 2,
    centerY: world.height / 2,
    zoom: 1,
    rotation: -0.08,
    selectedCell: null,
    hoverCell: null,
    mode: "observe",
  });
  primaryGesture = null;
  pinchGesture = null;
  activePointers.clear();
  ephemeralEvents = [];
  lastFrameMs = null;
  realAccumulator = 0;
  ui.showSpeciesSelection(SPECIES[CONTROLLED_SPECIES_ID]);
  syncAll();
  ui.announce("A fresh forest landscape is ready.", "calm");
  return true;
}

function derivePhase(restoredSimulation, restoredSpeciesId, savedPhase) {
  if (!restoredSpeciesId) {
    return "species-selection";
  }
  if (restoredSimulation.founderId === null) {
    return "site-selection";
  }
  const founderTree = restoredSimulation.trees.find(
    (tree) => tree.id === restoredSimulation.founderId && tree.founder,
  );
  if (!founderTree) {
    return "founder-landing";
  }
  return savedPhase === "play" ? "play" : "play";
}

function syncOnboarding() {
  if (phase === "species-selection") {
    ui.showSpeciesSelection(SPECIES[CONTROLLED_SPECIES_ID]);
    return;
  }
  if (phase === "site-selection") {
    ui.showStartGuidance();
    return;
  }
  hideOnboardingPanels();
}

function hideOnboardingPanels() {
  const panels = interfaceRoot.querySelectorAll(
    '[data-panel="species-selection"], [data-panel="start-guidance"]',
  );
  for (const panel of panels) {
    panel.hidden = true;
  }
}

function syncAll() {
  const mode = currentMode();
  view.mode = mode.renderer;
  canvas.dataset.mode = mode.canvas;
  document.documentElement.dataset.phase = phase;
  canvas.setAttribute("aria-label", canvasAriaLabel(mode.label));
  renderer.setSuitabilityVisible(suitabilityVisible);

  ui.update({
    treeCount: simulation.stats.alive,
    rp: simulation.rp,
    timeYears: simulation.timeYears,
    speed: simulation.speed,
    mode: mode.label,
    paused,
    seedMode: seedingMode,
    suitabilityVisible,
    canPlant: seedingMode || (phase === "play" && hasReproductiveSource()),
    canPause: simulation.founderId !== null,
    canSave: selectedSpeciesId !== null,
    canLoad: hasLocalSave(),
    canReset: true,
    canToggleSuitability: selectedSpeciesId !== null,
  });
  setTimeControlAvailability(
    phase === "play" || (phase === "founder-landing" && simulation.founderId !== null),
    phase === "founder-landing",
  );
}

function currentMode() {
  if (phase === "species-selection") {
    return { label: "Choose species", renderer: "observe", canvas: "inspect" };
  }
  if (phase === "site-selection") {
    return { label: "Choose site", renderer: "inspect", canvas: "site-selection" };
  }
  if (phase === "founder-landing") {
    return { label: "Founder landing", renderer: "observe", canvas: "inspect" };
  }
  if (seedingMode) {
    return { label: "Seeding", renderer: "plant", canvas: "plant" };
  }
  if (founderNeedsCare()) {
    return { label: "Nurture", renderer: "nurture", canvas: "nurture" };
  }
  return { label: "Observe", renderer: "observe", canvas: "inspect" };
}

function canvasAriaLabel(modeLabel) {
  return (
    "Interactive forest landscape. Current mode: " +
    modeLabel +
    ". Use the visible controls or pointer gestures to inspect and guide regeneration."
  );
}

function setTimeControlAvailability(enabled, landingLock) {
  const buttons = interfaceRoot.querySelectorAll('[data-action="time-speed"]');
  for (const button of buttons) {
    const speed = Number(button.dataset.speed);
    button.disabled = !enabled || (landingLock && speed !== 1);
    button.setAttribute(
      "aria-disabled",
      String(!enabled || (landingLock && speed !== 1)),
    );
  }
}

function hasLocalSave() {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

function hasReproductiveSource() {
  return simulation.trees.some((tree) => {
    if (!tree.alive || !tree.managed) {
      return false;
    }
    if (tree.founder) {
      return (
        simulation.founderNurture >= 1 &&
        ["sapling", "young", "mature", "senescent"].includes(tree.stage)
      );
    }
    return ["young", "mature", "senescent"].includes(tree.stage);
  });
}

function founderNeedsCare() {
  return phase === "play" && simulation.founderNurture < 1 && Boolean(founderTree());
}

function founderTree() {
  return (
    simulation.trees.find(
      (tree) => tree.id === simulation.founderId && tree.founder && tree.alive,
    ) ?? null
  );
}

function installInputHandlers() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onCanvasKeyDown);
  cameraControls.addEventListener("click", onCameraControl);
  window.addEventListener("resize", onResize);
  window.addEventListener("beforeunload", destroy);
}

function onPointerDown(event) {
  if (event.button !== 0 && event.pointerType !== "touch") {
    return;
  }
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  const screen = eventScreenPoint(event);
  activePointers.set(event.pointerId, screen);
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is an enhancement, not a requirement.
  }

  if (activePointers.size >= 2) {
    beginPinchGesture();
    primaryGesture = null;
    return;
  }

  const worldPoint = renderer.screenToWorld(screen.x, screen.y, view);
  const action = pointerAction(screen, worldPoint);
  primaryGesture = {
    pointerId: event.pointerId,
    action,
    startMs: performance.now(),
    startScreen: screen,
    lastScreen: screen,
    startWorld: worldPoint,
    lastWorld: worldPoint,
    startView: { ...view },
    distancePx: 0,
    moved: false,
  };
  canvas.dataset.pointerActive = "true";
}

function onPointerMove(event) {
  const screen = eventScreenPoint(event);
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, screen);
  }

  if (activePointers.size >= 2 && pinchGesture) {
    updatePinchGesture();
    return;
  }

  const hover = renderer.screenToWorld(screen.x, screen.y, view);
  view.hoverCell = hover.inside
    ? { worldX: hover.x, worldY: hover.y }
    : null;

  if (!primaryGesture || primaryGesture.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  const segment = Math.hypot(
    screen.x - primaryGesture.lastScreen.x,
    screen.y - primaryGesture.lastScreen.y,
  );
  primaryGesture.distancePx += segment;
  primaryGesture.lastScreen = screen;
  primaryGesture.lastWorld = renderer.screenToWorld(screen.x, screen.y, view);
  if (
    Math.hypot(
      screen.x - primaryGesture.startScreen.x,
      screen.y - primaryGesture.startScreen.y,
    ) >= POINTER_DRAG_THRESHOLD
  ) {
    primaryGesture.moved = true;
  }

  if (
    primaryGesture.action === "pan" ||
    (primaryGesture.action === "site-or-pan" && primaryGesture.moved)
  ) {
    panFromGesture(primaryGesture, screen);
  } else if (primaryGesture.action === "seed") {
    view.selectedCell = primaryGesture.lastWorld.inside
      ? { worldX: primaryGesture.lastWorld.x, worldY: primaryGesture.lastWorld.y }
      : view.selectedCell;
  }
}

function onPointerUp(event) {
  const screen = eventScreenPoint(event);
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, screen);
  }

  if (pinchGesture) {
    activePointers.delete(event.pointerId);
    if (activePointers.size < 2) {
      pinchGesture = null;
      primaryGesture = null;
      canvas.dataset.pointerActive = "false";
    }
    releasePointer(event.pointerId);
    return;
  }

  const gesture =
    primaryGesture && primaryGesture.pointerId === event.pointerId
      ? primaryGesture
      : null;
  activePointers.delete(event.pointerId);
  primaryGesture = null;
  canvas.dataset.pointerActive = "false";
  releasePointer(event.pointerId);
  if (!gesture) {
    return;
  }

  gesture.distancePx += Math.hypot(
    screen.x - gesture.lastScreen.x,
    screen.y - gesture.lastScreen.y,
  );
  gesture.lastScreen = screen;
  gesture.lastWorld = renderer.screenToWorld(screen.x, screen.y, view);
  gesture.moved =
    gesture.moved ||
    Math.hypot(
      screen.x - gesture.startScreen.x,
      screen.y - gesture.startScreen.y,
    ) >= POINTER_DRAG_THRESHOLD;

  if (gesture.action === "site-or-pan" && !gesture.moved) {
    attemptFounderPlacement(gesture.lastWorld);
    return;
  }
  if (gesture.action === "landing") {
    ui.announce("The founding samara is still settling into the site.", "calm");
    return;
  }
  if (gesture.action === "nurture") {
    applyNurtureGesture(gesture);
    return;
  }
  if (gesture.action === "seed") {
    // This is the only integration path that can disperse seed. The mode check
    // is repeated at release time so an interrupted gesture can never spend RP.
    if (canDisperse({ phase, seedingMode })) {
      applySeedingGesture(gesture);
    }
    return;
  }
  if (gesture.action === "pan" && !gesture.moved && gesture.lastWorld.inside) {
    view.selectedCell = {
      worldX: gesture.lastWorld.x,
      worldY: gesture.lastWorld.y,
    };
    announceSite(gesture.lastWorld);
  }
}

function onPointerCancel(event) {
  activePointers.delete(event.pointerId);
  if (primaryGesture && primaryGesture.pointerId === event.pointerId) {
    primaryGesture = null;
  }
  if (activePointers.size < 2) {
    pinchGesture = null;
  }
  canvas.dataset.pointerActive = "false";
  releasePointer(event.pointerId);
}

function onPointerLeave() {
  if (!primaryGesture && !pinchGesture) {
    view.hoverCell = null;
  }
}

function pointerAction(screen, worldPoint) {
  if (phase === "site-selection") {
    return "site-or-pan";
  }
  if (phase === "founder-landing") {
    return "landing";
  }
  if (phase !== "play") {
    return "pan";
  }
  if (seedingMode) {
    return "seed";
  }
  if (founderNeedsCare() && isNearFounder(screen)) {
    return "nurture";
  }
  return worldPoint.inside ? "pan" : "pan";
}

function attemptFounderPlacement(worldPoint) {
  if (!worldPoint.inside || phase !== "site-selection") {
    return;
  }
  const x = worldPoint.x;
  const y = worldPoint.y;
  const suitability = suitabilityAt(world, x, y, selectedSpeciesId);
  view.selectedCell = { worldX: x, worldY: y };
  const result = placeFounder(simulation, world, x, y);

  if (!result.accepted) {
    addEphemeralEvent({
      type: "founder-rejected",
      reason: "unsuitable-site",
      entityId: "rejected-" + eventSerial,
      x,
      y,
    });
    ui.showUnsuitableFeedback({
      title: "That site will not hold this seed",
      message:
        "This site scores " +
        Math.round(suitability * 100) +
        "% suitability, below the founding threshold.",
      hint: "Try a stronger part of the wash; marginal sites remain valid choices.",
    });
    syncAll();
    return;
  }

  phase = "founder-landing";
  seedingMode = false;
  paused = false;
  setTimeSpeed(simulation, 1);
  view.centerX = x;
  view.centerY = y;
  view.zoom = 4.6;
  view.selectedCell = { worldX: x, worldY: y };
  hideOnboardingPanels();
  ui.announce("The founding sugar-maple samara is falling at 1x time.", "success");
  syncAll();
}

function applyNurtureGesture(gesture) {
  if (seedingMode || phase !== "play") {
    return;
  }
  const durationMs = Math.max(0, performance.now() - gesture.startMs);
  const amount = clamp(
    0.24 + Math.min(0.22, durationMs / 4000) + Math.min(0.22, gesture.distancePx / 420),
    0.2,
    0.55,
  );
  const result = nurtureFounder(simulation, amount);
  if (!result.accepted) {
    ui.announce(
      result.reason === "founder-still-landing"
        ? "Let the founding samara finish establishing first."
        : "The founder does not need more close tending right now.",
      "calm",
    );
    return;
  }

  const founder = founderTree();
  if (founder) {
    addEphemeralEvent({
      type: "nurture-growth",
      reason: "sunlight-and-water",
      entityId: founder.id + "-nurture-" + eventSerial,
      x: founder.x,
      y: founder.y,
    });
  }
  const percent = Math.round(result.total * 100);
  ui.announce(
    result.total >= 1
      ? "The founder has the care it needs. Let forest time carry the growth forward."
      : "Sunlight and water: founder care is " + percent + "% complete.",
    result.total >= 1 ? "success" : "calm",
  );
  syncAll();
}

function applySeedingGesture(gesture) {
  if (!canDisperse({ phase, seedingMode })) {
    return;
  }
  const start = gesture.startWorld;
  const end = gesture.lastWorld;
  const durationMs = Math.max(0, performance.now() - gesture.startMs);
  const result = disperseFromGesture(simulation, world, {
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
    durationMs,
    distance: Math.hypot(end.x - start.x, end.y - start.y),
  });

  if (!result.accepted) {
    const messages = {
      "insufficient-rp":
        "The stand needs " + SIMULATION_RULES.seedCostRp + " RP for another samara.",
      "no-reproductive-source":
        "No managed tree is ready to release samaras yet.",
      "seed-capacity":
        "This alpha has reached its visible seed-attempt limit.",
    };
    ui.announce(messages[result.reason] || "That seeding gesture could not be completed.", "calm");
    syncAll();
    return;
  }

  ui.announce(
    "Released " +
      result.released +
      (result.released === 1 ? " samara. " : " samaras. ") +
      result.spent +
      " RP spent on dispersal.",
    "success",
  );
  syncAll();
}

function announceSite(worldPoint) {
  const cell = getCell(world, worldPoint.x, worldPoint.y);
  if (!cell) {
    return;
  }
  const score = Math.round(cell.suitability * 100);
  const band =
    cell.suitability < FOUNDER_MIN_SUITABILITY
      ? "effectively unsuitable"
      : cell.suitability < 0.55
        ? "marginal"
        : cell.suitability < 0.75
          ? "promising"
          : "strong";
  ui.announce("Site reading: " + band + ", " + score + "% suitability.", "calm");
}

function isNearFounder(screen) {
  const founder = founderTree();
  if (!founder) {
    return false;
  }
  const projected = renderer.worldToScreen(founder.x, founder.y, view);
  return Math.hypot(projected.x - screen.x, projected.y - screen.y) <= 64;
}

function panFromGesture(gesture, currentScreen) {
  const currentInStartView = renderer.screenToWorld(
    currentScreen.x,
    currentScreen.y,
    gesture.startView,
  );
  view.centerX = clamp(
    gesture.startView.centerX + gesture.startWorld.x - currentInStartView.x,
    -world.width * 0.08,
    world.width * 1.08,
  );
  view.centerY = clamp(
    gesture.startView.centerY + gesture.startWorld.y - currentInStartView.y,
    -world.height * 0.08,
    world.height * 1.08,
  );
}

function beginPinchGesture() {
  const points = Array.from(activePointers.values()).slice(0, 2);
  if (points.length < 2) {
    return;
  }
  const midpoint = midpointOf(points[0], points[1]);
  pinchGesture = {
    startDistance: Math.max(1, distanceBetween(points[0], points[1])),
    startAngle: Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x),
    startView: { ...view },
    anchorWorld: renderer.screenToWorld(midpoint.x, midpoint.y, view),
  };
  canvas.dataset.pointerActive = "true";
}

function updatePinchGesture() {
  const points = Array.from(activePointers.values()).slice(0, 2);
  if (!pinchGesture || points.length < 2) {
    return;
  }
  const midpoint = midpointOf(points[0], points[1]);
  const distance = Math.max(1, distanceBetween(points[0], points[1]));
  const angle = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
  view.zoom = clamp(
    pinchGesture.startView.zoom * (distance / pinchGesture.startDistance),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  view.rotation =
    pinchGesture.startView.rotation + normalizeAngle(angle - pinchGesture.startAngle);
  view.centerX = pinchGesture.startView.centerX;
  view.centerY = pinchGesture.startView.centerY;
  const after = renderer.screenToWorld(midpoint.x, midpoint.y, view);
  view.centerX += pinchGesture.anchorWorld.x - after.x;
  view.centerY += pinchGesture.anchorWorld.y - after.y;
  clampViewCenter();
}

function onWheel(event) {
  event.preventDefault();
  const screen = eventScreenPoint(event);
  const before = renderer.screenToWorld(screen.x, screen.y, view);
  const factor = Math.exp(-event.deltaY * 0.0014);
  view.zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const after = renderer.screenToWorld(screen.x, screen.y, view);
  view.centerX += before.x - after.x;
  view.centerY += before.y - after.y;
  clampViewCenter();
}

function onCanvasKeyDown(event) {
  let handled = true;
  const panAmount = Math.max(0.4, 3 / view.zoom);
  if (event.key === "ArrowLeft") {
    view.centerX -= panAmount;
  } else if (event.key === "ArrowRight") {
    view.centerX += panAmount;
  } else if (event.key === "ArrowUp") {
    view.centerY -= panAmount;
  } else if (event.key === "ArrowDown") {
    view.centerY += panAmount;
  } else if (event.key === "+" || event.key === "=") {
    zoomView(1.22);
  } else if (event.key === "-" || event.key === "_") {
    zoomView(1 / 1.22);
  } else if (event.key === "[") {
    rotateView(-Math.PI / 12);
  } else if (event.key === "]") {
    rotateView(Math.PI / 12);
  } else {
    handled = false;
  }
  if (handled) {
    clampViewCenter();
    event.preventDefault();
  }
}

function onCameraControl(event) {
  const button = event.target.closest("[data-camera-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.cameraAction;
  if (action === "zoom-in") {
    zoomView(1.25);
  } else if (action === "zoom-out") {
    zoomView(1 / 1.25);
  } else if (action === "rotate-left") {
    rotateView(-Math.PI / 12);
  } else if (action === "rotate-right") {
    rotateView(Math.PI / 12);
  } else if (action === "recenter") {
    recenterView();
  }
}

function zoomView(factor) {
  view.zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
}

function rotateView(amount) {
  view.rotation = normalizeAngle(view.rotation + amount);
}

function recenterView() {
  const founder = founderTree();
  view.centerX = founder ? founder.x : world.width / 2;
  view.centerY = founder ? founder.y : world.height / 2;
  view.zoom = founder ? 4.2 : 1;
}

function clampViewCenter() {
  view.centerX = clamp(view.centerX, -world.width * 0.08, world.width * 1.08);
  view.centerY = clamp(view.centerY, -world.height * 0.08, world.height * 1.08);
}

function onResize() {
  renderer.resize();
}

function frame(nowMs) {
  if (destroyed) {
    return;
  }
  if (lastFrameMs === null) {
    lastFrameMs = nowMs;
  }
  const frameSeconds = clamp((nowMs - lastFrameMs) / 1000, 0, MAX_FRAME_SECONDS);
  lastFrameMs = nowMs;

  if (!paused && simulation.founderId !== null) {
    realAccumulator += frameSeconds;
    let steps = 0;
    while (realAccumulator >= FIXED_REAL_STEP_SECONDS && steps < MAX_CATCH_UP_STEPS) {
      const deltaYears =
        FIXED_REAL_STEP_SECONDS *
        BASE_YEARS_PER_REAL_SECOND *
        simulation.speed;
      const summary = stepSimulation(simulation, world, deltaYears);
      handleSimulationSummary(summary);
      realAccumulator -= FIXED_REAL_STEP_SECONDS;
      steps += 1;
    }
    if (steps === MAX_CATCH_UP_STEPS) {
      realAccumulator = Math.min(realAccumulator, FIXED_REAL_STEP_SECONDS);
    }
  } else {
    realAccumulator = Math.min(realAccumulator, FIXED_REAL_STEP_SECONDS);
  }

  pruneEphemeralEvents(nowMs);
  renderer.render(renderState(), view, nowMs);
  syncAll();
  requestAnimationFrame(frame);
}

function handleSimulationSummary(summary) {
  if (phase === "founder-landing" && founderTree()) {
    phase = "play";
    seedingMode = false;
    hideOnboardingPanels();
    ui.announce(
      "The founding tree has established. Tend it in passive Nurture mode.",
      "success",
    );
  }

  if (summary.rpEarned > 0) {
    ui.announce(
      "+" + summary.rpEarned + " RP from successful regeneration and growth.",
      "success",
    );
  } else if (summary.failed > 0) {
    ui.announce(
      summary.failed +
        (summary.failed === 1
          ? " samara did not establish."
          : " samaras did not establish."),
      "calm",
    );
  }
}

function addEphemeralEvent(event) {
  const now = performance.now();
  ephemeralEvents.push({
    ...event,
    timeYears: simulation.timeYears,
    expiresAtMs: now + 3600,
  });
  eventSerial += 1;
  if (ephemeralEvents.length > 24) {
    ephemeralEvents.splice(0, ephemeralEvents.length - 24);
  }
}

function pruneEphemeralEvents(nowMs) {
  ephemeralEvents = ephemeralEvents.filter((event) => event.expiresAtMs > nowMs);
}

function renderState() {
  if (ephemeralEvents.length === 0) {
    return simulation;
  }
  return {
    ...simulation,
    events: [...simulation.events, ...ephemeralEvents],
  };
}

function sanitizeView(candidate, targetWorld) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    centerX: clamp(finiteOr(source.centerX, targetWorld.width / 2), -targetWorld.width * 0.08, targetWorld.width * 1.08),
    centerY: clamp(finiteOr(source.centerY, targetWorld.height / 2), -targetWorld.height * 0.08, targetWorld.height * 1.08),
    zoom: clamp(finiteOr(source.zoom, 1), MIN_ZOOM, MAX_ZOOM),
    rotation: normalizeAngle(finiteOr(source.rotation, -0.08)),
    selectedCell: sanitizeCellFocus(source.selectedCell, targetWorld),
    hoverCell: null,
    mode: "observe",
  };
}

function sanitizeCellFocus(candidate, targetWorld) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const x = finiteOr(candidate.worldX, candidate.x);
  const y = finiteOr(candidate.worldY, candidate.y);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= targetWorld.width ||
    y >= targetWorld.height
  ) {
    return null;
  }
  return { worldX: x, worldY: y };
}

function eventScreenPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function midpointOf(left, right) {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function distanceBetween(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function releasePointer(pointerId) {
  try {
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  } catch {
    // Some browsers release capture before pointerup dispatch completes.
  }
}

function finishBoot() {
  bootStatus.dataset.ready = "true";
  bootMessage.textContent = "Forest ready";
  window.setTimeout(() => {
    bootStatus.hidden = true;
  }, 460);
}

function reportBootError(error) {
  bootStatus.hidden = false;
  bootStatus.dataset.error = "true";
  bootStatus.dataset.ready = "false";
  bootMessage.textContent =
    "Stand alpha could not start. " +
    (error && error.message ? error.message : "Unknown error.");
  if (appLive) {
    appLive.textContent = bootMessage.textContent;
  }
}

function destroy() {
  if (destroyed) {
    return;
  }
  destroyed = true;
  renderer.destroy();
  ui.destroy();
  delete globalThis.__STAND_ALPHA__;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeAngle(value) {
  const tau = Math.PI * 2;
  let angle = value % tau;
  if (angle > Math.PI) {
    angle -= tau;
  } else if (angle < -Math.PI) {
    angle += tau;
  }
  return angle;
}
