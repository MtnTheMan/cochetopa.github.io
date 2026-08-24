export function createHeldPulseScheduler({ emit, intervalMs = 360, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof emit !== "function") throw new TypeError("emit is required");
  let active = false;
  let timer = null;

  function start({ immediate = true } = {}) {
    stop(); active = true;
    if (immediate) emit();
    schedule();
  }
  function schedule() {
    if (!active) return;
    timer = setTimer(() => {
      timer = null;
      if (!active) return;
      emit(); // Exactly one pulse per callback; a stalled frame never catches up.
      schedule();
    }, intervalMs);
  }
  function stop() {
    active = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  return Object.freeze({ start, stop, get active() { return active; } });
}

export function createInputController({ canvas, renderer, camera, getSnapshot, dispatch, now = () => performance.now(), onInput = () => {}, onFeedback = () => {} }) {
  let mode = "observe";
  let pointer = null;
  let commandOrdinal = 1;
  let touchPrecommitTimer = null;
  let currentDirection = { x: 1, y: 0 };
  const pulseScheduler = createHeldPulseScheduler({ emit: emitSeedPulse });

  function setMode(nextMode) {
    const normalized = nextMode === "seeding" ? "seeding" : "observe";
    if (mode === normalized) return;
    cancelGesture(); mode = normalized; canvas.dataset.mode = mode; onInput();
  }
  function getMode() { return mode; }

  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    onInput(); canvas.focus?.({ preventScroll: true });
    const point = localPoint(event); const snapshot = getSnapshot(now());
    pointer = { id: event.pointerId, type: event.pointerType || "mouse", startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, target: null, panWorld: renderer.screenToWorld(point.x, point.y, camera), released: false };
    canvas.setPointerCapture?.(event.pointerId); canvas.dataset.dragging = "true";
    if (mode === "seeding") {
      updateDirection(point, snapshot);
      if (pointer.type === "touch") {
        onFeedback("Aim samara release");
        touchPrecommitTimer = setTimeout(() => {
          touchPrecommitTimer = null;
          if (!pointer) return;
          emitSeedPulse();
          if (!pointer.released) pulseScheduler.start({ immediate: false });
          else finishPointer();
        }, 100);
      } else pulseScheduler.start({ immediate: true });
      event.preventDefault?.(); return;
    }
    pointer.target = renderer.hitTest(point.x, point.y, snapshot, camera);
    if (pointer.target) onFeedback(`Nurture ${pointer.target.featured ? "founder" : "managed tree"}`);
  }

  function pointerMove(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const point = localPoint(event); const distance = Math.hypot(point.x - pointer.startX, point.y - pointer.startY);
    onInput();
    if (mode === "seeding") { updateDirection(point, getSnapshot(now())); pointer.lastX = point.x; pointer.lastY = point.y; event.preventDefault?.(); return; }
    if (pointer.target && distance > 8) { pointer.target = null; pointer.panWorld = renderer.screenToWorld(point.x, point.y, camera); }
    if (!pointer.target && distance > 2) {
      const world = renderer.screenToWorld(point.x, point.y, camera);
      camera.centerX += pointer.panWorld.x - world.x; camera.centerY += pointer.panWorld.y - world.y;
      pointer.panWorld = renderer.screenToWorld(point.x, point.y, camera);
    }
    pointer.lastX = point.x; pointer.lastY = point.y; event.preventDefault?.();
  }

  function pointerUp(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    onInput();
    if (mode === "seeding") {
      pointer.released = true; pulseScheduler.stop();
      // A quick touch keeps only its already scheduled ordinal-zero decision.
      if (touchPrecommitTimer === null) finishPointer();
      event.preventDefault?.(); return;
    }
    if (pointer.target) {
      const result = dispatch({ id: `render-command-${commandOrdinal++}`, type: "nurture", targetId: pointer.target.id, presentationTimeMs: now() });
      onFeedback(result.accepted ? "Sunlight and water reached the tree" : humanReason(result.reason));
    }
    finishPointer();
  }

  function pointerCancel(event) { if (!pointer || event.pointerId !== pointer.id) return; cancelGesture(); onInput(); }
  function wheel(event) {
    cancelGesture(); onInput();
    const factor = Math.exp(-event.deltaY * 0.0018); camera.zoom = clamp(camera.zoom * factor, 0.72, 320);
    event.preventDefault?.();
  }
  function keyDown(event) {
    if (event.key === "Escape") { if (pointer) cancelGesture(); else if (mode === "seeding") setMode("observe"); }
  }

  function emitSeedPulse() {
    if (!pointer || mode !== "seeding") return;
    const snapshot = getSnapshot(now());
    const source = snapshot.individuals.find((entity) => entity.featured && entity.state === "living" && entity.relationship === "managed") || snapshot.individuals.find((entity) => entity.state === "living" && entity.relationship === "managed");
    if (!source) { onFeedback("No living managed seed source"); pulseScheduler.stop(); return; }
    const result = dispatch({ id: `render-command-${commandOrdinal++}`, type: "seed-attempt", sourceId: source.id, directionX: currentDirection.x, directionY: currentDirection.y, presentationTimeMs: now() });
    if (!result.accepted) onFeedback(humanReason(result.reason));
  }

  function updateDirection(point, snapshot) {
    const source = snapshot.individuals.find((entity) => entity.featured && entity.state === "living") || snapshot.individuals[0];
    if (!source) return;
    const sourceScreen = renderer.worldToScreen(source.x, source.y, camera);
    const length = Math.hypot(point.x - sourceScreen.x, point.y - sourceScreen.y);
    if (length > 2) currentDirection = { x: (point.x - sourceScreen.x) / length, y: (point.y - sourceScreen.y) / length };
  }
  function localPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function finishPointer() { if (pointer) canvas.releasePointerCapture?.(pointer.id); pointer = null; canvas.dataset.dragging = "false"; }
  function cancelGesture() { pulseScheduler.stop(); if (touchPrecommitTimer !== null) clearTimeout(touchPrecommitTimer); touchPrecommitTimer = null; finishPointer(); }
  function destroy() { cancelGesture(); canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", pointerCancel); canvas.removeEventListener("lostpointercapture", pointerCancel); canvas.removeEventListener("wheel", wheel); globalThis.removeEventListener?.("keydown", keyDown); }

  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", pointerCancel); canvas.addEventListener("lostpointercapture", pointerCancel); canvas.addEventListener("wheel", wheel, { passive: false }); globalThis.addEventListener?.("keydown", keyDown);
  canvas.dataset.mode = mode;
  return Object.freeze({ setMode, getMode, cancel: cancelGesture, destroy });
}

function humanReason(reason) { return ({ "insufficient-rp": "Not enough RP", "no-living-source": "No living managed seed source", "ineligible-target": "Only living managed trees can be nurtured", "direction-undetermined": "Choose a clear direction" })[reason] || "Action unavailable"; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
