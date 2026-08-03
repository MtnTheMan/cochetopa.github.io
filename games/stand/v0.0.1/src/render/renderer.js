const TAU = Math.PI * 2;
const UINT32_RANGE = 0x100000000;

const DEFAULTS = Object.freeze({
  isoY: 0.58,
  fitPadding: 1.08,
  minZoom: 0.08,
  maxZoom: 24,
  maxDevicePixelRatio: 2,
  maxAmbientTrees: 240,
  maxVisibleEntities: 1200,
  eventDurationMs: 3400,
  eventWindowYears: 0.35,
  suitabilityOpacity: 0.78,
  observeResize: true,
});

const COLORS = Object.freeze({
  paper: [242, 237, 220],
  paperShadow: [92, 88, 69],
  haze: [226, 232, 221],
  warmInk: [45, 47, 39],
  managedFoliage: [75, 119, 59],
  managedLight: [151, 174, 82],
  managedShade: [41, 78, 55],
  ambientFoliage: [143, 158, 130],
  ambientLight: [190, 197, 166],
  ambientShade: [102, 123, 105],
  stressedFoliage: [151, 99, 61],
  stressedLight: [190, 137, 80],
  stressedShade: [88, 64, 47],
  stem: [104, 83, 60],
  seed: [154, 123, 67],
  seedLight: [211, 185, 116],
  success: [93, 140, 78],
  failure: [158, 99, 67],
});

const MAPLE_LEAF_POINTS = Object.freeze([
  0, -1,
  0.13, -0.52,
  0.35, -0.72,
  0.31, -0.34,
  0.73, -0.5,
  0.49, -0.12,
  0.9, -0.08,
  0.48, 0.19,
  0.59, 0.48,
  0.18, 0.34,
  0.08, 0.78,
  0, 0.61,
  -0.08, 0.78,
  -0.18, 0.34,
  -0.59, 0.48,
  -0.48, 0.19,
  -0.9, -0.08,
  -0.49, -0.12,
  -0.73, -0.5,
  -0.31, -0.34,
  -0.35, -0.72,
  -0.13, -0.52,
]);

/**
 * Create the dependency-free Canvas 2D renderer for the alpha landscape.
 *
 * World coordinates use the data module convention: cell (x, y) occupies
 * [x, x + 1) by [y, y + 1). Screen coordinates are canvas-local CSS pixels.
 * Rotation is expressed in radians and zoom 1 fits the complete synthetic
 * landscape. Rendering state is always treated as read-only.
 */
export function createRenderer(canvas, world, options = {}) {
  assertCanvas(canvas);
  const dimensions = readWorldDimensions(world);
  const context = getCanvasContext(canvas);
  const sourceOptions =
    options && typeof options === "object" && !Array.isArray(options)
      ? options
      : {};
  const config = normalizeOptions(sourceOptions);
  const cellIndex = createCellIndex(world, dimensions);
  const ambientTrees = createAmbientTrees(world, dimensions, config.maxAmbientTrees);
  const surfaces = createWorldSurfaces(canvas, world, dimensions, cellIndex);
  const eventFirstSeen = new Map();

  let destroyed = false;
  let suitabilityVisible = sourceOptions.suitabilityVisible !== false;
  let resizeObserver = null;
  const metrics = {
    width: 1,
    height: 1,
    dpr: 1,
    fitScale: 1,
  };

  function resize() {
    if (destroyed) {
      return { width: metrics.width, height: metrics.height, dpr: metrics.dpr };
    }

    const measured = measureCanvas(canvas, metrics);
    const dpr = readDevicePixelRatio(
      canvas,
      config.maxDevicePixelRatio,
      sourceOptions,
    );
    const backingWidth = Math.max(1, Math.round(measured.width * dpr));
    const backingHeight = Math.max(1, Math.round(measured.height * dpr));

    if (canvas.width !== backingWidth) {
      canvas.width = backingWidth;
    }
    if (canvas.height !== backingHeight) {
      canvas.height = backingHeight;
    }

    metrics.width = measured.width;
    metrics.height = measured.height;
    metrics.dpr = dpr;
    metrics.fitScale = calculateFitScale(measured, dimensions, config);
    context.imageSmoothingEnabled = true;

    return { width: metrics.width, height: metrics.height, dpr: metrics.dpr };
  }

  function worldToScreen(worldX, worldY, view = {}) {
    const projection = createProjection(view, metrics, dimensions, config);
    const x = finiteOr(worldX, projection.centerX);
    const y = finiteOr(worldY, projection.centerY);
    return projectPoint(x, y, projection);
  }

  function screenToWorld(screenX, screenY, view = {}) {
    const projection = createProjection(view, metrics, dimensions, config);
    const sx = finiteOr(screenX, metrics.width / 2);
    const sy = finiteOr(screenY, metrics.height / 2);
    const rotatedX = (sx - metrics.width / 2) / projection.scale;
    const rotatedY =
      (sy - metrics.height / 2) / (projection.scale * projection.isoY);
    const dx =
      rotatedX * projection.cos + rotatedY * projection.sin;
    const dy =
      -rotatedX * projection.sin + rotatedY * projection.cos;
    const x = projection.centerX + dx;
    const y = projection.centerY + dy;
    const inside = x >= 0 && y >= 0 && x < dimensions.width && y < dimensions.height;

    return {
      x,
      y,
      inside,
      cellX: inside ? Math.floor(x) : null,
      cellY: inside ? Math.floor(y) : null,
    };
  }

  function setSuitabilityVisible(visible) {
    suitabilityVisible = Boolean(visible);
  }

  function render(state = {}, view = {}, nowMs = 0) {
    if (destroyed) {
      return;
    }

    resizeIfNeeded(
      canvas,
      metrics,
      resize,
      config.maxDevicePixelRatio,
      sourceOptions,
    );
    const projection = createProjection(view, metrics, dimensions, config);
    const animationTime = Number.isFinite(nowMs) ? nowMs : 0;

    resetContext(context, metrics);
    drawBackdrop(context, metrics, animationTime);
    drawGround(
      context,
      world,
      view,
      projection,
      metrics,
      dimensions,
      cellIndex,
      surfaces,
      suitabilityVisible,
      config,
    );

    const drawItems = collectDrawItems(
      state,
      ambientTrees,
      projection,
      metrics,
      config,
    );

    for (const item of drawItems) {
      if (item.kind === "tree") {
        drawTree(
          context,
          item.entity,
          item.screen,
          projection,
          animationTime,
          item.ambient,
          item.visualSeed,
          item.opacity,
        );
      } else {
        drawSamara(
          context,
          item.entity,
          item.screen,
          projection,
          animationTime,
          item.visualSeed,
        );
      }
    }

    drawRecentEvents(
      context,
      state,
      projection,
      metrics,
      animationTime,
      eventFirstSeen,
      config,
      view,
    );
    drawAtmosphericHaze(context, metrics, animationTime);
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    eventFirstSeen.clear();
    ambientTrees.length = 0;
    surfaces.terrain = null;
    surfaces.suitability = null;
  }

  resize();

  const ResizeObserverConstructor = globalThis.ResizeObserver;
  if (
    config.observeResize &&
    typeof ResizeObserverConstructor === "function" &&
    typeof canvas === "object"
  ) {
    resizeObserver = new ResizeObserverConstructor(() => resize());
    resizeObserver.observe(canvas);
  }

  return Object.freeze({
    resize,
    render,
    screenToWorld,
    worldToScreen,
    setSuitabilityVisible,
    destroy,
  });
}

function assertCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError("createRenderer requires a canvas-like object.");
  }
}

function getCanvasContext(canvas) {
  let context = null;
  try {
    context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
  } catch {
    context = canvas.getContext("2d");
  }
  if (!context) {
    context = canvas.getContext("2d");
  }
  if (!context) {
    throw new TypeError("Canvas 2D is unavailable.");
  }
  return context;
}

function readWorldDimensions(world) {
  if (
    !world ||
    !Number.isSafeInteger(world.width) ||
    !Number.isSafeInteger(world.height) ||
    world.width <= 0 ||
    world.height <= 0 ||
    !Array.isArray(world.cells)
  ) {
    throw new TypeError("Renderer world must contain positive dimensions and cells.");
  }
  return { width: world.width, height: world.height };
}

function normalizeOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  return {
    isoY: clamp(finiteOr(source.isoY, DEFAULTS.isoY), 0.35, 0.82),
    fitPadding: clamp(
      finiteOr(source.fitPadding, DEFAULTS.fitPadding),
      1,
      1.8,
    ),
    minZoom: clamp(finiteOr(source.minZoom, DEFAULTS.minZoom), 0.01, 1),
    maxZoom: clamp(finiteOr(source.maxZoom, DEFAULTS.maxZoom), 1, 80),
    maxDevicePixelRatio: clamp(
      finiteOr(source.maxDevicePixelRatio, DEFAULTS.maxDevicePixelRatio),
      1,
      4,
    ),
    maxAmbientTrees: clampInteger(
      source.maxAmbientTrees,
      0,
      800,
      DEFAULTS.maxAmbientTrees,
    ),
    maxVisibleEntities: clampInteger(
      source.maxVisibleEntities,
      50,
      5000,
      DEFAULTS.maxVisibleEntities,
    ),
    eventDurationMs: clamp(
      finiteOr(source.eventDurationMs, DEFAULTS.eventDurationMs),
      500,
      10000,
    ),
    eventWindowYears: clamp(
      finiteOr(source.eventWindowYears, DEFAULTS.eventWindowYears),
      0,
      20,
    ),
    suitabilityOpacity: clamp(
      finiteOr(source.suitabilityOpacity, DEFAULTS.suitabilityOpacity),
      0,
      1,
    ),
    observeResize: source.observeResize !== false,
    pixelsPerWorldUnit:
      Number.isFinite(source.pixelsPerWorldUnit) &&
      source.pixelsPerWorldUnit > 0
        ? source.pixelsPerWorldUnit
        : null,
  };
}

function measureCanvas(canvas, metrics) {
  let rect = null;
  if (typeof canvas.getBoundingClientRect === "function") {
    rect = canvas.getBoundingClientRect();
  }

  const rectWidth = rect && Number.isFinite(rect.width) ? rect.width : 0;
  const rectHeight = rect && Number.isFinite(rect.height) ? rect.height : 0;
  const clientWidth = Number.isFinite(canvas.clientWidth) ? canvas.clientWidth : 0;
  const clientHeight = Number.isFinite(canvas.clientHeight) ? canvas.clientHeight : 0;
  const currentDpr = metrics.dpr || 1;
  const backingWidth = Number.isFinite(canvas.width) ? canvas.width / currentDpr : 0;
  const backingHeight = Number.isFinite(canvas.height) ? canvas.height / currentDpr : 0;

  return {
    width: Math.max(1, rectWidth || clientWidth || backingWidth || 640),
    height: Math.max(1, rectHeight || clientHeight || backingHeight || 480),
  };
}

function readDevicePixelRatio(canvas, maximum, options) {
  const explicit =
    options && Number.isFinite(options.devicePixelRatio)
      ? options.devicePixelRatio
      : null;
  const ownerRatio =
    canvas.ownerDocument &&
    canvas.ownerDocument.defaultView &&
    Number.isFinite(canvas.ownerDocument.defaultView.devicePixelRatio)
      ? canvas.ownerDocument.defaultView.devicePixelRatio
      : null;
  const globalRatio = Number.isFinite(globalThis.devicePixelRatio)
    ? globalThis.devicePixelRatio
    : 1;
  return clamp(explicit || ownerRatio || globalRatio, 1, maximum);
}

function calculateFitScale(measured, dimensions, config) {
  if (config.pixelsPerWorldUnit) {
    return config.pixelsPerWorldUnit;
  }
  const diagonal = Math.max(
    1,
    Math.hypot(dimensions.width, dimensions.height),
  );
  const widthScale = measured.width / (diagonal * config.fitPadding);
  const heightScale =
    measured.height / (diagonal * config.isoY * config.fitPadding);
  return Math.max(0.1, Math.min(widthScale, heightScale));
}

function resizeIfNeeded(
  canvas,
  metrics,
  resize,
  maximumDpr,
  sourceOptions,
) {
  const nextDpr = readDevicePixelRatio(canvas, maximumDpr, sourceOptions);
  if (Math.abs(nextDpr - metrics.dpr) > 0.001) {
    resize();
    return;
  }
  if (typeof canvas.getBoundingClientRect !== "function") {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (
    rect &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0 &&
    (Math.abs(rect.width - metrics.width) > 0.5 ||
      Math.abs(rect.height - metrics.height) > 0.5)
  ) {
    resize();
  }
}

function createProjection(view, metrics, dimensions, config) {
  const source = view && typeof view === "object" ? view : {};
  const centerX = finiteOr(source.centerX, dimensions.width / 2);
  const centerY = finiteOr(source.centerY, dimensions.height / 2);
  const zoom = clamp(
    finiteOr(source.zoom, 1),
    config.minZoom,
    config.maxZoom,
  );
  const rotation = finiteOr(source.rotation, 0);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scale = Math.max(0.0001, metrics.fitScale * zoom);
  const a = scale * cos;
  const b = scale * config.isoY * sin;
  const c = -scale * sin;
  const d = scale * config.isoY * cos;
  const e = metrics.width / 2 - a * centerX - c * centerY;
  const f = metrics.height / 2 - b * centerX - d * centerY;

  return {
    centerX,
    centerY,
    zoom,
    rotation,
    cos,
    sin,
    scale,
    isoY: config.isoY,
    a,
    b,
    c,
    d,
    e,
    f,
  };
}

function projectPoint(x, y, projection) {
  return {
    x: projection.a * x + projection.c * y + projection.e,
    y: projection.b * x + projection.d * y + projection.f,
  };
}

function resetContext(context, metrics) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, Math.max(1, metrics.width * metrics.dpr), Math.max(1, metrics.height * metrics.dpr));
  context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
}

function drawBackdrop(context, metrics, nowMs) {
  const wash = context.createLinearGradient(0, 0, 0, metrics.height);
  wash.addColorStop(0, rgba([235, 237, 221], 1));
  wash.addColorStop(0.55, rgba(COLORS.paper, 1));
  wash.addColorStop(1, rgba([224, 218, 198], 1));
  context.fillStyle = wash;
  context.fillRect(0, 0, metrics.width, metrics.height);

  const sunX = metrics.width * (0.2 + 0.025 * Math.sin(nowMs * 0.00005));
  const sunY = metrics.height * 0.12;
  const light = context.createRadialGradient(
    sunX,
    sunY,
    0,
    sunX,
    sunY,
    Math.max(metrics.width, metrics.height) * 0.72,
  );
  light.addColorStop(0, "rgba(255, 249, 216, 0.24)");
  light.addColorStop(1, "rgba(255, 249, 216, 0)");
  context.fillStyle = light;
  context.fillRect(0, 0, metrics.width, metrics.height);
}

function drawGround(
  context,
  world,
  view,
  projection,
  metrics,
  dimensions,
  cellIndex,
  surfaces,
  suitabilityVisible,
  config,
) {
  const corners = [
    projectPoint(0, 0, projection),
    projectPoint(dimensions.width, 0, projection),
    projectPoint(dimensions.width, dimensions.height, projection),
    projectPoint(0, dimensions.height, projection),
  ];

  context.save();
  context.translate(0, clamp(projection.scale * 0.36, 5, 14));
  tracePolygon(context, corners);
  context.fillStyle = rgba(COLORS.paperShadow, 0.17);
  context.fill();
  context.restore();

  context.save();
  applyWorldTransform(context, projection);
  context.beginPath();
  context.rect(0, 0, dimensions.width, dimensions.height);
  context.clip();
  context.fillStyle = rgba(COLORS.paper, 1);
  context.fillRect(0, 0, dimensions.width, dimensions.height);

  if (surfaces.terrain) {
    context.globalAlpha = 0.94;
    context.drawImage(
      surfaces.terrain,
      0,
      0,
      dimensions.width,
      dimensions.height,
    );
    context.globalAlpha = 1;
  } else {
    drawFallbackTerrain(context, world, dimensions);
  }

  if (suitabilityVisible) {
    context.save();
    context.globalCompositeOperation = "multiply";
    context.globalAlpha = config.suitabilityOpacity;
    if (surfaces.suitability) {
      context.drawImage(
        surfaces.suitability,
        0,
        0,
        dimensions.width,
        dimensions.height,
      );
    } else {
      drawFallbackSuitability(context, world, dimensions);
    }
    context.restore();
  }

  if (!surfaces.terrain) {
    drawFallbackPaperFibers(
      context,
      dimensions,
      finiteInteger(world.seed, 0),
    );
  }

  drawFocusMark(
    context,
    readCellFocus(view && view.hoverCell, dimensions),
    projection,
    false,
    view && view.mode,
  );
  drawFocusMark(
    context,
    readCellFocus(view && view.selectedCell, dimensions),
    projection,
    true,
    view && view.mode,
  );
  context.restore();

  context.save();
  tracePolygon(context, corners);
  context.strokeStyle = rgba([91, 96, 75], 0.2);
  context.lineWidth = 0.7;
  context.setLineDash([5, 3, 1.5, 4]);
  context.stroke();
  context.restore();
}

function tracePolygon(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.closePath();
}

function applyWorldTransform(context, projection) {
  context.transform(
    projection.a,
    projection.b,
    projection.c,
    projection.d,
    projection.e,
    projection.f,
  );
}

function drawFallbackTerrain(context, world, dimensions) {
  const gradient = context.createLinearGradient(
    0,
    0,
    dimensions.width,
    dimensions.height,
  );
  gradient.addColorStop(0, "rgba(218, 225, 200, 0.58)");
  gradient.addColorStop(0.52, "rgba(238, 229, 194, 0.42)");
  gradient.addColorStop(1, "rgba(203, 214, 195, 0.58)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, dimensions.width, dimensions.height);

  const cells = Array.isArray(world.cells) ? world.cells : [];
  const stride = Math.max(1, Math.ceil(cells.length / 120));
  for (let index = 0; index < cells.length; index += stride) {
    const cell = cells[index];
    if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y)) {
      continue;
    }
    const moisture = unit(cell.moisture, 0.5);
    const elevation = unit(cell.elevation, 0.5);
    const tint = mixRgb(
      [205, 218, 195],
      [214, 194, 155],
      elevation * 0.65,
    );
    const radius = 4.5 + moisture * 2;
    const glaze = context.createRadialGradient(
      cell.x + 0.5,
      cell.y + 0.5,
      0,
      cell.x + 0.5,
      cell.y + 0.5,
      radius,
    );
    glaze.addColorStop(0, rgba(tint, 0.055));
    glaze.addColorStop(1, rgba(tint, 0));
    context.fillStyle = glaze;
    context.fillRect(
      cell.x + 0.5 - radius,
      cell.y + 0.5 - radius,
      radius * 2,
      radius * 2,
    );
  }
}

function drawFallbackSuitability(context, world) {
  const cells = Array.isArray(world.cells) ? world.cells : [];
  const stride = Math.max(1, Math.ceil(cells.length / 160));
  for (let index = 0; index < cells.length; index += stride) {
    const cell = cells[index];
    if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y)) {
      continue;
    }
    const suitability = unit(cell.suitability, 0.5);
    const color = suitabilityColor(suitability);
    const radius = 4.8;
    const wash = context.createRadialGradient(
      cell.x + 0.5,
      cell.y + 0.5,
      0,
      cell.x + 0.5,
      cell.y + 0.5,
      radius,
    );
    wash.addColorStop(0, rgba(color, 0.16 + suitability * 0.08));
    wash.addColorStop(1, rgba(color, 0));
    context.fillStyle = wash;
    context.fillRect(
      cell.x + 0.5 - radius,
      cell.y + 0.5 - radius,
      radius * 2,
      radius * 2,
    );
  }
}

function drawFallbackPaperFibers(context, dimensions, seed) {
  context.save();
  context.globalCompositeOperation = "multiply";
  context.lineWidth = 0.035;
  for (let index = 0; index < 110; index += 1) {
    const x = hashUnit(seed, index, 301) * dimensions.width;
    const y = hashUnit(seed, index, 307) * dimensions.height;
    const length = 0.35 + hashUnit(seed, index, 311) * 1.4;
    const angle = hashUnit(seed, index, 313) * TAU;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length * 0.22,
    );
    context.strokeStyle = "rgba(96, 89, 68, 0.055)";
    context.stroke();
  }
  context.restore();
}

function drawFocusMark(context, focus, projection, selected, mode) {
  if (!focus) {
    return;
  }
  const planting = typeof mode === "string" && /plant/i.test(mode);
  const scale = projection.scale;
  context.save();
  context.beginPath();
  context.ellipse(
    focus.x,
    focus.y,
    selected ? 0.48 : 0.4,
    selected ? 0.36 : 0.3,
    -0.12,
    0,
    TAU,
  );
  context.lineWidth = (selected ? 1.25 : 0.85) / scale;
  context.setLineDash(
    selected
      ? [4 / scale, 2.4 / scale, 1 / scale, 2.8 / scale]
      : [2 / scale, 3.5 / scale],
  );
  context.strokeStyle = selected
    ? rgba(COLORS.warmInk, 0.62)
    : planting
      ? rgba(COLORS.seed, 0.55)
      : rgba([78, 105, 87], 0.38);
  context.stroke();
  context.restore();
}

function readCellFocus(value, dimensions) {
  if (!value) {
    return null;
  }

  let cellX;
  let cellY;
  if (
    typeof value === "object" &&
    Number.isFinite(value.worldX) &&
    Number.isFinite(value.worldY)
  ) {
    const x = value.worldX;
    const y = value.worldY;
    return x >= 0 && y >= 0 && x < dimensions.width && y < dimensions.height
      ? { x, y }
      : null;
  }
  if (
    typeof value === "object" &&
    Number.isFinite(value.cellX) &&
    Number.isFinite(value.cellY)
  ) {
    cellX = value.cellX;
    cellY = value.cellY;
  } else if (Array.isArray(value) && value.length >= 2) {
    cellX = value[0];
    cellY = value[1];
  } else if (
    typeof value === "object" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  ) {
    cellX = value.x;
    cellY = value.y;
  } else {
    return null;
  }

  const x = Math.floor(cellX);
  const y = Math.floor(cellY);
  if (x < 0 || y < 0 || x >= dimensions.width || y >= dimensions.height) {
    return null;
  }
  return { x: x + 0.5, y: y + 0.5 };
}

function collectDrawItems(state, ambientTrees, projection, metrics, config) {
  const items = [];
  const scale = projection.scale;
  const ambientReveal = lerp(0.22, 1, smoothRange(4.5, 13, scale));

  for (let index = 0; index < ambientTrees.length; index += 1) {
    const tree = ambientTrees[index];
    const opacity =
      1 -
      smoothRange(
        ambientReveal,
        Math.min(1.08, ambientReveal + 0.08),
        tree.revealPriority,
      );
    if (opacity <= 0.01) {
      continue;
    }
    const screen = projectPoint(tree.x, tree.y, projection);
    if (isVisible(screen, metrics, 72)) {
      items.push({
        kind: "tree",
        ambient: true,
        entity: tree,
        screen,
        visualSeed: tree.visualSeed,
        opacity,
      });
    }
  }

  const trees = state && Array.isArray(state.trees) ? state.trees : [];
  for (let index = 0; index < trees.length; index += 1) {
    const tree = trees[index];
    if (!hasWorldPosition(tree)) {
      continue;
    }
    const screen = projectPoint(tree.x, tree.y, projection);
    if (isVisible(screen, metrics, 110)) {
      items.push({
        kind: "tree",
        ambient: false,
        entity: tree,
        screen,
        visualSeed: entityVisualSeed(tree, 401),
      });
    }
  }

  const seeds = state && Array.isArray(state.seeds) ? state.seeds : [];
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    if (!hasWorldPosition(seed)) {
      continue;
    }
    const screen = projectPoint(seed.x, seed.y, projection);
    if (isVisible(screen, metrics, 80)) {
      items.push({
        kind: "seed",
        ambient: false,
        entity: seed,
        screen,
        visualSeed: entityVisualSeed(seed, 409),
      });
    }
  }

  if (items.length > config.maxVisibleEntities) {
    const centerX = metrics.width * 0.5;
    const centerY = metrics.height * 0.5;
    items.sort((left, right) => {
      if (left.ambient !== right.ambient) {
        return left.ambient ? 1 : -1;
      }
      const leftFounder = Boolean(left.entity && left.entity.founder);
      const rightFounder = Boolean(right.entity && right.entity.founder);
      if (leftFounder !== rightFounder) {
        return leftFounder ? -1 : 1;
      }
      const leftDistance =
        (left.screen.x - centerX) ** 2 + (left.screen.y - centerY) ** 2;
      const rightDistance =
        (right.screen.x - centerX) ** 2 + (right.screen.y - centerY) ** 2;
      if (Math.abs(leftDistance - rightDistance) > 0.001) {
        return leftDistance - rightDistance;
      }
      return left.visualSeed - right.visualSeed;
    });
    items.length = config.maxVisibleEntities;
  }

  items.sort(compareDrawDepth);
  return items;
}

function compareDrawDepth(left, right) {
  const depth = left.screen.y - right.screen.y;
  if (Math.abs(depth) > 0.001) {
    return depth;
  }
  if (left.kind !== right.kind) {
    return left.kind === "seed" ? -1 : 1;
  }
  return left.visualSeed - right.visualSeed;
}

function isVisible(screen, metrics, margin) {
  return (
    screen.x >= -margin &&
    screen.y >= -margin &&
    screen.x <= metrics.width + margin &&
    screen.y <= metrics.height + margin
  );
}

function hasWorldPosition(entity) {
  return (
    entity &&
    typeof entity === "object" &&
    Number.isFinite(entity.x) &&
    Number.isFinite(entity.y)
  );
}

function drawTree(
  context,
  entity,
  screen,
  projection,
  nowMs,
  ambient,
  visualSeed,
  visibility = 1,
) {
  const stage = classifyTreeStage(entity);
  const alive = entity.alive !== false && stage !== "dead";
  const managed = !ambient && entity.managed !== false;
  const founder = Boolean(entity.founder);
  const vitality = unit(entity.vitality, alive ? 1 : 0);
  const sizeFactor = treeSizeFactor(entity.size);
  const scale = projection.scale;
  const depthHaze = clamp(0.7 + screen.y / 1800, 0.66, 1);
  const ambientFactor = ambient ? 0.84 : 1;
  const sway =
    Math.sin(nowMs * 0.00042 + visualSeed * 0.000017) *
    clamp(scale * 0.025, 0.15, 1.35);

  const dimensions = treePixelDimensions(
    stage,
    scale,
    sizeFactor * ambientFactor,
  );
  const baseX = screen.x;
  const baseY = screen.y;

  if (!alive) {
    drawSnag(
      context,
      baseX,
      baseY,
      dimensions,
      managed,
      vitality,
      visualSeed,
    );
    return;
  }

  context.save();
  context.globalAlpha =
    depthHaze * (ambient ? 0.76 : 1) * unit(visibility, 1);

  if (founder) {
    const founderBloom = context.createRadialGradient(
      baseX,
      baseY,
      0,
      baseX,
      baseY,
      clamp(dimensions.radius * 1.6, 7, 58),
    );
    founderBloom.addColorStop(0, "rgba(196, 174, 96, 0.14)");
    founderBloom.addColorStop(1, "rgba(196, 174, 96, 0)");
    context.fillStyle = founderBloom;
    context.beginPath();
    context.ellipse(
      baseX,
      baseY,
      clamp(dimensions.radius * 1.6, 7, 58),
      clamp(dimensions.radius * 0.52, 3, 17),
      0,
      0,
      TAU,
    );
    context.fill();
  }

  drawContactShadow(
    context,
    baseX,
    baseY,
    dimensions.radius,
    ambient ? 0.08 : 0.15,
  );

  if (stage === "seedling") {
    drawSeedling(
      context,
      entity,
      baseX,
      baseY,
      dimensions,
      managed,
      ambient,
      vitality,
      visualSeed,
      scale,
    );
  } else {
    drawCrownedTree(
      context,
      entity,
      baseX + sway,
      baseY,
      dimensions,
      managed,
      ambient,
      founder,
      vitality,
      visualSeed,
      scale,
      stage,
    );
  }
  context.restore();
}

function classifyTreeStage(entity) {
  const text =
    entity && typeof entity.stage === "string"
      ? entity.stage.toLowerCase()
      : "";
  if (/dead|snag|mort/.test(text) || (entity && entity.alive === false)) {
    return "dead";
  }
  if (/seed|germin|sprout|emerg/.test(text)) {
    return "seedling";
  }
  if (/sap|juven|recruit|young/.test(text)) {
    return "sapling";
  }
  if (/mature|adult|repro|canopy|old/.test(text)) {
    return "mature";
  }
  const age = entity && Number.isFinite(entity.age) ? entity.age : 10;
  if (age < 1.5) {
    return "seedling";
  }
  if (age < 10) {
    return "sapling";
  }
  return "mature";
}

function treeSizeFactor(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  if (value <= 1.5) {
    return clamp(0.58 + value * 0.58, 0.62, 1.42);
  }
  return clamp(0.82 + Math.log2(value + 1) * 0.13, 0.9, 1.58);
}

function treePixelDimensions(stage, scale, sizeFactor) {
  if (stage === "seedling") {
    return {
      height: clamp(scale * 0.28 * sizeFactor, 5, 18),
      radius: clamp(scale * 0.12 * sizeFactor, 2.5, 8),
    };
  }
  if (stage === "sapling") {
    return {
      height: clamp(scale * 0.7 * sizeFactor, 10, 40),
      radius: clamp(scale * 0.28 * sizeFactor, 4, 19),
    };
  }
  return {
    height: clamp(scale * 1.32 * sizeFactor, 14, 78),
    radius: clamp(scale * 0.52 * sizeFactor, 5, 42),
  };
}

function drawContactShadow(context, x, y, radius, opacity) {
  context.save();
  context.fillStyle = "rgba(67, 79, 75, " + opacity + ")";
  context.beginPath();
  context.ellipse(
    x + radius * 0.08,
    y + 0.8,
    Math.max(2, radius * 0.7),
    Math.max(1, radius * 0.2),
    -0.08,
    0,
    TAU,
  );
  context.fill();
  context.restore();
}

function drawSeedling(
  context,
  entity,
  x,
  y,
  dimensions,
  managed,
  ambient,
  vitality,
  visualSeed,
  scale,
) {
  const droop = (1 - vitality) * dimensions.height * 0.28;
  const topX = x + droop * 0.32;
  const topY = y - dimensions.height + droop;
  const colors = treeColors(managed, ambient, vitality);

  context.beginPath();
  context.moveTo(x, y);
  context.quadraticCurveTo(
    x - droop * 0.18,
    y - dimensions.height * 0.56,
    topX,
    topY,
  );
  context.strokeStyle = rgba(COLORS.stem, ambient ? 0.46 : 0.78);
  context.lineWidth = managed ? 1.15 : 0.85;
  context.stroke();

  const leafRadius = dimensions.radius * (0.72 + vitality * 0.28);
  const leafAngle = 0.42 + (1 - vitality) * 0.72;
  drawLeaf(
    context,
    topX - leafRadius * 0.52,
    topY,
    leafRadius,
    leafAngle + Math.PI,
    rgba(colors.light, ambient ? 0.52 : 0.76),
    managed ? rgba(COLORS.warmInk, 0.62) : rgba(colors.shade, 0.25),
    managed ? 0.7 : 0.45,
  );
  drawLeaf(
    context,
    topX + leafRadius * 0.55,
    topY + leafRadius * 0.18,
    leafRadius,
    -leafAngle,
    rgba(colors.base, ambient ? 0.5 : 0.78),
    managed ? rgba(COLORS.warmInk, 0.62) : rgba(colors.shade, 0.25),
    managed ? 0.7 : 0.45,
  );

  const seedlingMotifPresence = smoothRange(12, 18, scale);
  if (seedlingMotifPresence > 0.01 && vitality > 0.22) {
    drawMapleLeafMotif(
      context,
      topX,
      topY - leafRadius * 0.56,
      leafRadius * 0.78,
      (hashUnit(visualSeed, 1, 417) - 0.5) * 0.64,
      mixRgb(colors.base, colors.light, 0.24),
      seedlingMotifPresence * (managed ? 0.58 : 0.25),
      managed ? smoothRange(12, 22, scale) * 0.42 : 0,
      managed,
      vitality,
      visualSeed ^ 0x6a09e667,
    );
  }

  if (vitality < 0.38) {
    context.beginPath();
    context.moveTo(topX, topY + leafRadius * 0.3);
    context.quadraticCurveTo(
      topX + leafRadius,
      topY + leafRadius,
      topX + leafRadius * 0.7,
      topY + leafRadius * 1.5,
    );
    context.strokeStyle = rgba(COLORS.failure, 0.54);
    context.lineWidth = 0.75;
    context.setLineDash([1.5, 1.8]);
    context.stroke();
  }

  if (managed && hashUnit(visualSeed, 1, 419) > 0.55) {
    context.fillStyle = rgba(COLORS.warmInk, 0.42);
    context.beginPath();
    context.arc(x, y, 1.05, 0, TAU);
    context.fill();
  }
}

function drawCrownedTree(
  context,
  entity,
  x,
  y,
  dimensions,
  managed,
  ambient,
  founder,
  vitality,
  visualSeed,
  scale,
  stage,
) {
  const colors = treeColors(managed, ambient, vitality);
  const fullness = 0.65 + vitality * 0.35;
  const crownRadius =
    dimensions.radius * fullness * (stage === "sapling" ? 0.86 : 1);
  const crownY = y - dimensions.height * (stage === "sapling" ? 0.67 : 0.72);
  const droop = (1 - vitality) * crownRadius * 0.42;
  const trunkTopY = crownY + crownRadius * 0.2;

  context.beginPath();
  context.moveTo(x, y);
  context.quadraticCurveTo(
    x - dimensions.radius * 0.06,
    y - dimensions.height * 0.54,
    x,
    trunkTopY,
  );
  context.strokeStyle = rgba(
    COLORS.stem,
    ambient ? 0.38 : managed ? 0.78 : 0.52,
  );
  context.lineWidth = clamp(
    dimensions.radius * (stage === "sapling" ? 0.13 : 0.17),
    1,
    managed ? 4.2 : 3,
  );
  context.stroke();

  context.beginPath();
  context.moveTo(x, crownY + crownRadius * 0.5);
  context.lineTo(x - crownRadius * 0.44, crownY + crownRadius * 0.05);
  context.moveTo(x, crownY + crownRadius * 0.36);
  context.lineTo(x + crownRadius * 0.42, crownY - crownRadius * 0.08);
  context.strokeStyle = rgba(COLORS.stem, ambient ? 0.24 : 0.55);
  context.lineWidth = clamp(dimensions.radius * 0.08, 0.7, 2.1);
  context.stroke();

  traceOrganicBlob(
    context,
    x,
    crownY + droop,
    crownRadius,
    crownRadius * (0.84 + vitality * 0.1),
    visualSeed,
    vitality,
  );
  context.fillStyle = rgba(colors.base, ambient ? 0.54 : managed ? 0.78 : 0.62);
  context.fill();

  context.save();
  context.globalCompositeOperation = "multiply";
  traceOrganicBlob(
    context,
    x + crownRadius * 0.18,
    crownY + crownRadius * 0.2 + droop,
    crownRadius * 0.78,
    crownRadius * 0.58,
    visualSeed ^ 0x4f1bbcdc,
    vitality,
  );
  context.fillStyle = rgba(colors.shade, ambient ? 0.2 : 0.28);
  context.fill();
  context.restore();

  traceOrganicBlob(
    context,
    x - crownRadius * 0.2,
    crownY - crownRadius * 0.22 + droop * 0.28,
    crownRadius * 0.58,
    crownRadius * 0.44,
    visualSeed ^ 0x728bc22d,
    vitality,
  );
  context.fillStyle = rgba(colors.light, ambient ? 0.31 : 0.38);
  context.fill();

  drawPigmentGranules(
    context,
    x,
    crownY,
    crownRadius,
    colors.shade,
    visualSeed,
    ambient ? 2 : scale > 16 ? 6 : 3,
  );

  drawSugarMapleMotifs(
    context,
    entity,
    x,
    crownY + droop * 0.4,
    crownRadius,
    colors,
    managed,
    ambient,
    founder,
    vitality,
    visualSeed,
    scale,
  );

  if (vitality < 0.58) {
    drawCrownGaps(
      context,
      x,
      crownY + droop,
      crownRadius,
      vitality,
      visualSeed,
    );
  }

  const inkRoll = hashUnit(visualSeed, 11, 431);
  const distantInk = smoothRange(0.8, 0.96, inkRoll) * 0.72;
  const standInk =
    smoothRange(7, 11, scale) * smoothRange(0.42, 0.78, inkRoll) * 0.86;
  const closeInk =
    smoothRange(13, 19, scale) * smoothRange(0.22, 0.64, inkRoll);
  const managedInkStrength = managed
    ? founder
      ? 1
      : Math.max(distantInk, standInk, closeInk)
    : 0;
  if (managedInkStrength > 0.01) {
    traceOrganicBlob(
      context,
      x,
      crownY + droop,
      crownRadius,
      crownRadius * (0.84 + vitality * 0.1),
      visualSeed,
      vitality,
    );
    context.strokeStyle = rgba(
      COLORS.warmInk,
      founder
        ? 0.82
        : (0.42 + smoothRange(7, 16, scale) * 0.28) *
          managedInkStrength,
    );
    context.lineWidth = clamp(0.62 + scale * 0.022, 0.68, 1.45);
    context.setLineDash(
      !founder || vitality < 0.48
        ? [3.2, 1.9, 0.8, 2.6]
        : [],
    );
    context.stroke();
  } else if (!managed) {
    const ambientContourStrength = smoothRange(14, 20, scale);
    if (ambientContourStrength <= 0.01) {
      return;
    }
    traceOrganicBlob(
      context,
      x,
      crownY + droop,
      crownRadius,
      crownRadius * (0.84 + vitality * 0.1),
      visualSeed,
      vitality,
    );
    context.strokeStyle = rgba(
      colors.shade,
      (ambient ? 0.18 : 0.25) * ambientContourStrength,
    );
    context.lineWidth = 0.55;
    context.setLineDash([2.4, 3.6]);
    context.stroke();
  }

  const branchInkStrength = managed
    ? founder
      ? 1
      : smoothRange(12, 18, scale)
    : 0;
  if (branchInkStrength > 0.01) {
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(x, crownY + crownRadius * 0.5);
    context.quadraticCurveTo(
      x - crownRadius * 0.08,
      crownY + crownRadius * 0.14,
      x - crownRadius * 0.4,
      crownY - crownRadius * 0.08,
    );
    context.moveTo(x + crownRadius * 0.03, crownY + crownRadius * 0.32);
    context.quadraticCurveTo(
      x + crownRadius * 0.16,
      crownY + crownRadius * 0.02,
      x + crownRadius * 0.37,
      crownY - crownRadius * 0.18,
    );
    context.strokeStyle = rgba(COLORS.warmInk, 0.42 * branchInkStrength);
    context.lineWidth = clamp(scale * 0.035, 0.55, 1.05);
    context.stroke();
  }
}

function drawSugarMapleMotifs(
  context,
  entity,
  x,
  y,
  crownRadius,
  colors,
  managed,
  ambient,
  founder,
  vitality,
  visualSeed,
  scale,
) {
  const species = String(
    (entity && (entity.speciesId || entity.species)) || "acer-saccharum",
  ).toLowerCase();
  if (
    !species.includes("acer") &&
    !species.includes("sacchar") &&
    !species.includes("sugar") &&
    species !== "maple"
  ) {
    return;
  }

  const detail = smoothRange(6, 22, scale);
  const distantThreshold = managed ? 0.76 : ambient ? 0.91 : 0.66;
  const distantEligible =
    founder ||
    hashUnit(visualSeed, 1, 433) > distantThreshold;
  const maximum = ambient ? 3 : managed ? 5 : 4;
  const healthySlots = Math.max(
    1,
    Math.ceil(maximum * (0.38 + vitality * 0.62)),
  );
  const slotThresholds = [8, 11.5, 16, 20.5, 24.5];

  for (let index = 0; index < maximum; index += 1) {
    if (index >= healthySlots) {
      continue;
    }

    let presence;
    if (index === 0) {
      presence = distantEligible
        ? 0.42 + 0.58 * smoothRange(5, 12, scale)
        : smoothRange(9, 14, scale);
    } else {
      presence = smoothRange(
        slotThresholds[index] - 2.2,
        slotThresholds[index] + 2.2,
        scale,
      );
    }
    if (presence <= 0.02) {
      continue;
    }

    const angle = hashUnit(visualSeed, index, 659) * TAU;
    const distance =
      Math.sqrt(hashUnit(visualSeed, index, 661)) *
      crownRadius *
      (index === 0 ? 0.24 : 0.56);
    const motifX = x + Math.cos(angle) * distance;
    const motifY = y + Math.sin(angle) * distance * 0.62;
    const motifRotation =
      (hashUnit(visualSeed, index, 673) - 0.5) * 1.9 +
      (index % 2 === 0 ? -0.14 : 0.14);
    const motifSize =
      crownRadius *
      lerp(0.62, 0.38, detail) *
      (0.84 + hashUnit(visualSeed, index, 677) * 0.34);
    const managedMotifTarget =
      index % 3 === 0
        ? colors.shade
        : index % 3 === 1
          ? colors.light
          : colors.base;
    const motifColor = managed
      ? mixRgb(colors.base, managedMotifTarget, 0.42)
      : mixRgb(colors.light, colors.base, 0.48);
    const fillAlpha =
      presence * (managed ? 0.38 : ambient ? 0.18 : 0.25);
    const inkAlpha =
      managed &&
      (founder ||
        index === 0 ||
        hashUnit(visualSeed, index, 683) > 0.52)
        ? presence * smoothRange(7, 17, scale) * 0.62
        : 0;
    const showVeins =
      managed &&
      (founder || hashUnit(visualSeed, index, 691) > 0.24);

    drawMapleLeafMotif(
      context,
      motifX,
      motifY,
      motifSize,
      motifRotation,
      motifColor,
      fillAlpha,
      inkAlpha,
      showVeins,
      vitality,
      visualSeed ^ Math.imul(index + 1, 0x9e3779b1),
    );
  }
}

function drawMapleLeafMotif(
  context,
  x,
  y,
  size,
  rotation,
  color,
  fillAlpha,
  inkAlpha,
  showVeins,
  vitality,
  seed,
) {
  const damage = 1 - vitality;

  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.scale(size, size * 0.78);
  context.beginPath();
  for (
    let pointIndex = 0;
    pointIndex < MAPLE_LEAF_POINTS.length;
    pointIndex += 2
  ) {
    const index = pointIndex / 2;
    const eatenEdge =
      damage > 0.42 &&
      (index === 5 || index === 16) &&
      hashUnit(seed, index, 697) > 0.34
        ? 0.72
        : 1;
    const px = MAPLE_LEAF_POINTS[pointIndex] * eatenEdge;
    const py =
      MAPLE_LEAF_POINTS[pointIndex + 1] *
      (0.97 + hashUnit(seed, index, 701) * 0.06);
    if (index === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  }
  context.closePath();
  context.fillStyle = rgba(color, fillAlpha);
  context.fill();

  if (inkAlpha > 0.01) {
    context.strokeStyle = rgba(COLORS.warmInk, inkAlpha);
    context.lineWidth = clamp(0.7 / Math.max(1, size), 0.035, 0.14);
    context.setLineDash(
      vitality < 0.48 ? [0.18, 0.12, 0.04, 0.14] : [],
    );
    context.stroke();
  }

  if (showVeins && inkAlpha > 0.01) {
    context.beginPath();
    context.moveTo(0, 0.64);
    context.lineTo(0, -0.75);
    context.moveTo(0, 0.25);
    context.lineTo(-0.62, -0.2);
    context.moveTo(0, 0.25);
    context.lineTo(0.62, -0.2);
    context.moveTo(0, 0.08);
    context.lineTo(-0.31, -0.48);
    context.moveTo(0, 0.08);
    context.lineTo(0.31, -0.48);
    context.strokeStyle = rgba(COLORS.warmInk, inkAlpha * 0.78);
    context.lineWidth = clamp(0.52 / Math.max(1, size), 0.026, 0.1);
    context.setLineDash([]);
    context.stroke();
  }
  context.restore();
}

function treeColors(managed, ambient, vitality) {
  const healthyBase = managed
    ? COLORS.managedFoliage
    : COLORS.ambientFoliage;
  const healthyLight = managed ? COLORS.managedLight : COLORS.ambientLight;
  const healthyShade = managed ? COLORS.managedShade : COLORS.ambientShade;
  const stressMix = ambient ? (1 - vitality) * 0.52 : 1 - vitality;
  return {
    base: mixRgb(healthyBase, COLORS.stressedFoliage, stressMix),
    light: mixRgb(healthyLight, COLORS.stressedLight, stressMix),
    shade: mixRgb(healthyShade, COLORS.stressedShade, stressMix),
  };
}

function traceOrganicBlob(
  context,
  x,
  y,
  radiusX,
  radiusY,
  seed,
  vitality,
) {
  const count = radiusX < 7 ? 8 : 11;
  const droop = (1 - vitality) * radiusY * 0.25;
  const firstAngle = -Math.PI / 2;
  const firstVariation = 0.82 + hashUnit(seed, 0, 443) * 0.26;
  let currentX = x + Math.cos(firstAngle) * radiusX * firstVariation;
  let currentY = y + Math.sin(firstAngle) * radiusY * firstVariation;

  const lastIndex = count - 1;
  const lastAngle = -Math.PI / 2 + (lastIndex / count) * TAU;
  const lastVariation = 0.82 + hashUnit(seed, lastIndex, 443) * 0.26;
  const lastX = x + Math.cos(lastAngle) * radiusX * lastVariation;
  const lastY =
    y +
    Math.sin(lastAngle) * radiusY * lastVariation +
    (Math.sin(lastAngle) > 0 ? droop : 0);

  context.beginPath();
  context.moveTo((lastX + currentX) * 0.5, (lastY + currentY) * 0.5);
  for (let index = 0; index < count; index += 1) {
    const nextIndex = (index + 1) % count;
    const nextAngle = -Math.PI / 2 + (nextIndex / count) * TAU;
    const nextVariation =
      0.82 + hashUnit(seed, nextIndex, 443) * 0.26;
    const nextX = x + Math.cos(nextAngle) * radiusX * nextVariation;
    const nextY =
      y +
      Math.sin(nextAngle) * radiusY * nextVariation +
      (Math.sin(nextAngle) > 0 ? droop : 0);
    context.quadraticCurveTo(
      currentX,
      currentY,
      (currentX + nextX) * 0.5,
      (currentY + nextY) * 0.5,
    );
    currentX = nextX;
    currentY = nextY;
  }
  context.closePath();
}

function drawPigmentGranules(
  context,
  x,
  y,
  radius,
  color,
  seed,
  count,
) {
  context.save();
  context.fillStyle = rgba(color, 0.16);
  for (let index = 0; index < count; index += 1) {
    const angle = hashUnit(seed, index, 449) * TAU;
    const distance = Math.sqrt(hashUnit(seed, index, 457)) * radius * 0.72;
    const granule = 0.35 + hashUnit(seed, index, 461) * Math.max(0.45, radius * 0.06);
    context.beginPath();
    context.arc(
      x + Math.cos(angle) * distance,
      y + Math.sin(angle) * distance * 0.72,
      granule,
      0,
      TAU,
    );
    context.fill();
  }
  context.restore();
}

function drawCrownGaps(context, x, y, radius, vitality, seed) {
  const count = vitality < 0.28 ? 3 : 2;
  context.save();
  context.fillStyle = rgba(COLORS.haze, 0.48);
  for (let index = 0; index < count; index += 1) {
    const angle = hashUnit(seed, index, 463) * TAU;
    const distance = radius * (0.18 + hashUnit(seed, index, 467) * 0.3);
    context.beginPath();
    context.ellipse(
      x + Math.cos(angle) * distance,
      y + Math.sin(angle) * distance * 0.62,
      radius * (0.09 + hashUnit(seed, index, 479) * 0.08),
      radius * (0.06 + hashUnit(seed, index, 487) * 0.07),
      angle,
      0,
      TAU,
    );
    context.fill();
  }
  context.restore();
}

function drawSnag(
  context,
  x,
  y,
  dimensions,
  managed,
  vitality,
  visualSeed,
) {
  const height = dimensions.height * (0.72 + vitality * 0.15);
  context.save();
  drawContactShadow(context, x, y, dimensions.radius, 0.12);
  context.beginPath();
  context.moveTo(x, y);
  context.quadraticCurveTo(
    x + dimensions.radius * 0.1,
    y - height * 0.52,
    x - dimensions.radius * 0.06,
    y - height,
  );
  context.strokeStyle = rgba(
    mixRgb(COLORS.stem, COLORS.stressedShade, 0.58),
    managed ? 0.86 : 0.55,
  );
  context.lineWidth = clamp(dimensions.radius * 0.18, 1.2, 4.4);
  context.stroke();

  const branchY = y - height * 0.58;
  context.beginPath();
  context.moveTo(x, branchY);
  context.lineTo(
    x - dimensions.radius * 0.75,
    branchY - dimensions.radius * 0.62,
  );
  context.moveTo(x, branchY - dimensions.radius * 0.2);
  context.lineTo(
    x + dimensions.radius * 0.72,
    branchY - dimensions.radius * 0.86,
  );
  context.moveTo(x, y - height * 0.8);
  context.lineTo(
    x + dimensions.radius * 0.34,
    y - height * 0.98,
  );
  context.strokeStyle = rgba(COLORS.stressedShade, managed ? 0.78 : 0.48);
  context.lineWidth = clamp(dimensions.radius * 0.1, 0.8, 2.2);
  context.setLineDash(managed ? [3, 1.8] : []);
  context.stroke();

  if (hashUnit(visualSeed, 1, 491) > 0.45) {
    context.fillStyle = rgba(COLORS.stressedFoliage, 0.3);
    context.beginPath();
    context.ellipse(
      x + dimensions.radius * 0.52,
      branchY - dimensions.radius * 0.72,
      Math.max(1.1, dimensions.radius * 0.18),
      Math.max(0.8, dimensions.radius * 0.1),
      0.72,
      0,
      TAU,
    );
    context.fill();
  }
  context.restore();
}

function drawLeaf(
  context,
  x,
  y,
  radius,
  angle,
  fill,
  stroke,
  lineWidth,
) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.beginPath();
  context.ellipse(0, 0, radius, radius * 0.48, 0, 0, TAU);
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = lineWidth;
  context.stroke();
  context.restore();
}

function drawSamara(
  context,
  seed,
  screen,
  projection,
  nowMs,
  visualSeed,
) {
  const state =
    typeof seed.state === "string" ? seed.state.toLowerCase() : "landed";
  const failed = /fail|wilt|dead|reject/.test(state);
  const germinating = /germin|sprout|emerg|establish/.test(state);
  const airborne =
    /fall|air|flight|drift|dispers/.test(state) ||
    state === "landing" ||
    state === "released";
  const activelyLanding = state === "landing";
  const descending = activelyLanding || state === "falling";
  const managed = seed.managed !== false;
  const age = Number.isFinite(seed.age) ? Math.max(0, seed.age) : 0;

  if (failed) {
    const failedFor = Number.isFinite(seed.resolutionAge)
      ? Math.max(0, age - seed.resolutionAge)
      : Math.min(age, 0.8);
    drawWiltCue(
      context,
      screen.x,
      screen.y,
      clamp(projection.scale * 0.32, 6, 18),
      clamp(1 - failedFor / 0.55, 0.32, 1),
    );
    return;
  }

  if (germinating) {
    drawSproutCue(
      context,
      screen.x,
      screen.y,
      clamp(projection.scale * 0.27, 5, 15),
      managed,
      0.88,
    );
    return;
  }

  const radius = clamp(projection.scale * 0.12, 2.8, 10);
  const landingDuration = seed.founder ? 0.05 : 0.06;
  const landingProgress = descending
    ? clamp(age / landingDuration, 0, 1)
    : 0;
  const descentLift = projection.scale * 0.9 * (1 - landingProgress);
  const flutterLift =
    Math.abs(Math.sin(nowMs * 0.002 + visualSeed)) *
    projection.scale *
    0.28 *
    (descending ? 1 - landingProgress * 0.72 : 1);
  const lift = airborne
    ? clamp(
        (descending ? descentLift : projection.scale * 0.85) +
          flutterLift,
        1.5,
        42,
      )
    : 1.5;
  const angle =
    finiteOr(seed.visualAngle, hashUnit(visualSeed, 1, 499) * TAU) +
    (airborne ? nowMs * 0.006 : nowMs * 0.00018);

  context.save();
  if (airborne) {
    context.fillStyle = "rgba(61, 70, 66, 0.12)";
    context.beginPath();
    context.ellipse(
      screen.x,
      screen.y + 1,
      radius * 1.4,
      radius * 0.36,
      0,
      0,
      TAU,
    );
    context.fill();
  }
  context.translate(screen.x, screen.y - lift);
  context.rotate(angle);
  drawSamaraWing(
    context,
    radius,
    1,
    managed,
  );
  drawSamaraWing(
    context,
    radius,
    -1,
    managed,
  );
  context.fillStyle = rgba(COLORS.seed, managed ? 0.88 : 0.58);
  context.beginPath();
  context.arc(0, 0, Math.max(1.2, radius * 0.23), 0, TAU);
  context.fill();
  context.restore();
}

function drawSamaraWing(context, radius, direction, managed) {
  context.beginPath();
  context.moveTo(0, 0);
  context.quadraticCurveTo(
    direction * radius * 0.9,
    -radius * 1.1,
    direction * radius * 2,
    -radius * 0.54,
  );
  context.quadraticCurveTo(
    direction * radius * 1.54,
    radius * 0.08,
    direction * radius * 0.18,
    radius * 0.18,
  );
  context.closePath();
  context.fillStyle = rgba(COLORS.seedLight, managed ? 0.7 : 0.45);
  context.fill();
  context.strokeStyle = managed
    ? rgba(COLORS.warmInk, 0.5)
    : rgba(COLORS.seed, 0.3);
  context.lineWidth = 0.65;
  context.stroke();
}

function drawRecentEvents(
  context,
  state,
  projection,
  metrics,
  nowMs,
  eventFirstSeen,
  config,
  view,
) {
  const events = state && Array.isArray(state.events) ? state.events : [];
  const stateTime = state && Number.isFinite(state.timeYears)
    ? state.timeYears
    : null;
  const feedbackEvents = normalizeFeedbackEvents(
    view && view.feedback,
    stateTime,
  );
  const recent = events.slice(-24).concat(feedbackEvents).slice(-32);
  const activeKeys = new Set();

  for (const event of recent) {
    if (!hasWorldPosition(event)) {
      continue;
    }
    const kind = classifyEvent(event);
    if (!kind) {
      continue;
    }
    if (
      stateTime !== null &&
      Number.isFinite(event.timeYears) &&
      stateTime - event.timeYears > config.eventWindowYears &&
      !eventFirstSeen.has(eventKey(event))
    ) {
      continue;
    }

    const key = eventKey(event);
    activeKeys.add(key);
    if (!eventFirstSeen.has(key)) {
      eventFirstSeen.set(key, nowMs);
    }
    let firstSeen = eventFirstSeen.get(key);
    if (nowMs < firstSeen) {
      firstSeen = nowMs;
      eventFirstSeen.set(key, firstSeen);
    }
    const ageMs = nowMs - firstSeen;
    if (ageMs > config.eventDurationMs) {
      continue;
    }

    const screen = projectPoint(event.x, event.y, projection);
    if (!isVisible(screen, metrics, 60)) {
      continue;
    }
    const alpha = clamp(1 - ageMs / config.eventDurationMs, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(ageMs * 0.009);
    if (kind === "failure") {
      drawFailureEvent(
        context,
        screen.x,
        screen.y,
        projection.scale,
        alpha,
        pulse,
      );
    } else {
      drawSuccessEvent(
        context,
        screen.x,
        screen.y,
        projection.scale,
        alpha,
        pulse,
      );
    }
  }

  for (const [key, firstSeen] of eventFirstSeen) {
    if (
      !activeKeys.has(key) ||
      nowMs - firstSeen > config.eventDurationMs * 1.5
    ) {
      eventFirstSeen.delete(key);
    }
  }
  while (eventFirstSeen.size > 96) {
    const oldest = eventFirstSeen.keys().next().value;
    eventFirstSeen.delete(oldest);
  }
}

function classifyEvent(event) {
  const type = String(event.type || "").toLowerCase();
  const reason = String(event.reason || "").toLowerCase();
  if (type === "rp-earned") {
    return null;
  }
  if (
    type === "founder-rejected" ||
    type === "seed-failed" ||
    type === "tree-died"
  ) {
    return "failure";
  }
  if (type === "seed-germinating" || type === "tree-established") {
    return "success";
  }
  if (type === "tree-stage-changed") {
    return ["sapling", "young", "mature"].includes(reason)
      ? "success"
      : null;
  }

  const text = type + " " + reason;
  if (/fail|wilt|reject|unsuit|mort|dead|death|die|stress/i.test(text)) {
    return "failure";
  }
  if (/establish|germin|sprout|matur|growth|founder-land/i.test(text)) {
    return "success";
  }
  return null;
}

function normalizeFeedbackEvents(feedback, stateTime) {
  const values = Array.isArray(feedback)
    ? feedback
    : feedback && typeof feedback === "object"
      ? [feedback]
      : [];
  const normalized = [];

  for (const value of values.slice(-8)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const position =
      value.position || value.point || value.world || value.location || value;
    const x = finiteOr(position.x, position.worldX);
    const y = finiteOr(position.y, position.worldY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    normalized.push({
      type: value.type || value.kind || "founder-rejected",
      reason: value.reason || value.message || "unsuitable",
      entityId: value.entityId || value.id || value.key || "presentation-cue",
      timeYears: Number.isFinite(value.timeYears)
        ? value.timeYears
        : finiteOr(stateTime, 0),
      x,
      y,
    });
  }
  return normalized;
}

function eventKey(event) {
  return [
    event.type || "",
    event.reason || "",
    event.entityId || "",
    Number.isFinite(event.timeYears) ? event.timeYears : "",
    event.x,
    event.y,
  ].join("|");
}

function drawFailureEvent(context, x, y, scale, alpha, pulse) {
  const radius = clamp(scale * (0.38 + pulse * 0.08), 7, 23);
  context.save();
  context.beginPath();
  context.ellipse(x, y, radius, radius * 0.3, 0, 0, TAU);
  context.strokeStyle = rgba(COLORS.failure, alpha * 0.46);
  context.lineWidth = 1;
  context.setLineDash([3, 2.4, 0.8, 2]);
  context.stroke();
  drawWiltCue(context, x, y, clamp(scale * 0.34, 7, 18), alpha);
  context.restore();
}

function drawSuccessEvent(context, x, y, scale, alpha, pulse) {
  const radius = clamp(scale * (0.34 + pulse * 0.12), 6, 22);
  const bloom = context.createRadialGradient(x, y, 0, x, y, radius);
  bloom.addColorStop(0, rgba(COLORS.success, alpha * 0.22));
  bloom.addColorStop(1, rgba(COLORS.success, 0));
  context.fillStyle = bloom;
  context.beginPath();
  context.ellipse(x, y, radius, radius * 0.36, 0, 0, TAU);
  context.fill();
  drawSproutCue(
    context,
    x,
    y,
    clamp(scale * 0.26, 5, 14),
    true,
    alpha,
  );
}

function drawWiltCue(context, x, y, height, alpha) {
  context.save();
  context.beginPath();
  context.moveTo(x, y);
  context.quadraticCurveTo(
    x - height * 0.18,
    y - height * 0.62,
    x + height * 0.18,
    y - height * 0.73,
  );
  context.quadraticCurveTo(
    x + height * 0.38,
    y - height * 0.69,
    x + height * 0.31,
    y - height * 0.48,
  );
  context.strokeStyle = rgba(COLORS.stressedShade, alpha * 0.82);
  context.lineWidth = 1.15;
  context.stroke();
  drawLeaf(
    context,
    x + height * 0.3,
    y - height * 0.44,
    height * 0.18,
    1.15,
    rgba(COLORS.stressedFoliage, alpha * 0.62),
    rgba(COLORS.stressedShade, alpha * 0.58),
    0.65,
  );
  context.restore();
}

function drawSproutCue(context, x, y, height, managed, alpha) {
  context.save();
  context.beginPath();
  context.moveTo(x, y);
  context.quadraticCurveTo(
    x - height * 0.08,
    y - height * 0.5,
    x,
    y - height,
  );
  context.strokeStyle = rgba(
    managed ? COLORS.managedShade : COLORS.ambientShade,
    alpha * 0.74,
  );
  context.lineWidth = 1;
  context.stroke();
  drawLeaf(
    context,
    x - height * 0.18,
    y - height * 0.78,
    height * 0.2,
    0.35,
    rgba(
      managed ? COLORS.managedLight : COLORS.ambientLight,
      alpha * 0.68,
    ),
    managed
      ? rgba(COLORS.warmInk, alpha * 0.48)
      : rgba(COLORS.ambientShade, alpha * 0.3),
    0.6,
  );
  drawLeaf(
    context,
    x + height * 0.19,
    y - height * 0.68,
    height * 0.2,
    -0.36,
    rgba(
      managed ? COLORS.managedFoliage : COLORS.ambientFoliage,
      alpha * 0.7,
    ),
    managed
      ? rgba(COLORS.warmInk, alpha * 0.48)
      : rgba(COLORS.ambientShade, alpha * 0.3),
    0.6,
  );
  context.restore();
}

function drawAtmosphericHaze(context, metrics, nowMs) {
  context.save();
  const upperHaze = context.createLinearGradient(
    0,
    0,
    0,
    metrics.height * 0.72,
  );
  upperHaze.addColorStop(
    0,
    "rgba(230, 235, 224, " +
      (0.3 + Math.sin(nowMs * 0.00011) * 0.015) +
      ")",
  );
  upperHaze.addColorStop(0.55, "rgba(230, 235, 224, 0.06)");
  upperHaze.addColorStop(1, "rgba(230, 235, 224, 0)");
  context.fillStyle = upperHaze;
  context.fillRect(0, 0, metrics.width, metrics.height);

  const vignette = context.createRadialGradient(
    metrics.width * 0.5,
    metrics.height * 0.46,
    Math.min(metrics.width, metrics.height) * 0.12,
    metrics.width * 0.5,
    metrics.height * 0.46,
    Math.max(metrics.width, metrics.height) * 0.75,
  );
  vignette.addColorStop(0, "rgba(246, 242, 223, 0)");
  vignette.addColorStop(1, "rgba(91, 87, 67, 0.075)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, metrics.width, metrics.height);
  context.restore();
}

function createCellIndex(world, dimensions) {
  const index = new Map();
  for (const cell of world.cells) {
    if (
      cell &&
      Number.isInteger(cell.x) &&
      Number.isInteger(cell.y) &&
      cell.x >= 0 &&
      cell.y >= 0 &&
      cell.x < dimensions.width &&
      cell.y < dimensions.height
    ) {
      index.set(cell.y * dimensions.width + cell.x, cell);
    }
  }
  return index;
}

function createWorldSurfaces(canvas, world, dimensions, cellIndex) {
  const surfaceWidth = clampInteger(
    Math.round(dimensions.width * 5),
    72,
    480,
    160,
  );
  const surfaceHeight = clampInteger(
    Math.round(dimensions.height * 5),
    72,
    420,
    120,
  );
  const terrain = createSurfaceCanvas(canvas, surfaceWidth, surfaceHeight);
  const suitability = createSurfaceCanvas(
    canvas,
    surfaceWidth,
    surfaceHeight,
  );

  if (!terrain || !suitability) {
    return { terrain: null, suitability: null };
  }

  let terrainContext = null;
  let suitabilityContext = null;
  try {
    terrainContext = terrain.getContext("2d");
    suitabilityContext = suitability.getContext("2d");
  } catch {
    return { terrain: null, suitability: null };
  }
  if (
    !terrainContext ||
    !suitabilityContext ||
    typeof terrainContext.createImageData !== "function" ||
    typeof suitabilityContext.createImageData !== "function"
  ) {
    return { terrain: null, suitability: null };
  }

  let terrainImage = null;
  let suitabilityImage = null;
  try {
    terrainImage = terrainContext.createImageData(surfaceWidth, surfaceHeight);
    suitabilityImage = suitabilityContext.createImageData(
      surfaceWidth,
      surfaceHeight,
    );
  } catch {
    return { terrain: null, suitability: null };
  }

  for (let py = 0; py < surfaceHeight; py += 1) {
    const worldY = ((py + 0.5) / surfaceHeight) * dimensions.height;
    for (let px = 0; px < surfaceWidth; px += 1) {
      const worldX = ((px + 0.5) / surfaceWidth) * dimensions.width;
      const moisture = sampleCellProperty(
        cellIndex,
        dimensions,
        worldX,
        worldY,
        "moisture",
        0.5,
      );
      const elevation = sampleCellProperty(
        cellIndex,
        dimensions,
        worldX,
        worldY,
        "elevation",
        0.5,
      );
      const light = sampleCellProperty(
        cellIndex,
        dimensions,
        worldX,
        worldY,
        "light",
        0.5,
      );
      const soil = sampleCellProperty(
        cellIndex,
        dimensions,
        worldX,
        worldY,
        "soil",
        0.5,
      );
      const suitabilityValue = sampleCellProperty(
        cellIndex,
        dimensions,
        worldX,
        worldY,
        "suitability",
        0.5,
      );

      let terrainColor = mixRgb(
        COLORS.paper,
        [176, 204, 190],
        moisture * 0.23,
      );
      terrainColor = mixRgb(
        terrainColor,
        [215, 194, 151],
        elevation * 0.13 + light * 0.05,
      );
      terrainColor = mixRgb(
        terrainColor,
        [180, 194, 153],
        soil * 0.08,
      );

      const pixelIndex = (py * surfaceWidth + px) * 4;
      writePixel(terrainImage.data, pixelIndex, terrainColor, 255);
      writePixel(
        suitabilityImage.data,
        pixelIndex,
        suitabilityColor(suitabilityValue),
        Math.round(82 + suitabilityValue * 45),
      );
    }
  }

  // The authoritative values use containing-cell semantics. A small bounded
  // pigment diffusion pass softens only their visual edges so the substrate
  // remains a wash instead of revealing the hidden simulation grid.
  softenSurfaceImage(terrainImage, surfaceWidth, surfaceHeight, 1);
  softenSurfaceImage(suitabilityImage, surfaceWidth, surfaceHeight, 2);
  terrainContext.putImageData(terrainImage, 0, 0);
  suitabilityContext.putImageData(suitabilityImage, 0, 0);
  addSurfacePaperTexture(
    terrainContext,
    surfaceWidth,
    surfaceHeight,
    finiteInteger(world.seed, 0),
  );
  addSuitabilityGranulation(
    suitabilityContext,
    surfaceWidth,
    surfaceHeight,
    finiteInteger(world.seed, 0),
  );
  return { terrain, suitability };
}

function createSurfaceCanvas(canvas, width, height) {
  const OffscreenCanvasConstructor = globalThis.OffscreenCanvas;
  if (typeof OffscreenCanvasConstructor === "function") {
    try {
      const offscreen = new OffscreenCanvasConstructor(width, height);
      if (supportsSurfaceCanvas(offscreen)) {
        return offscreen;
      }
    } catch {
      // Some embedded browsers expose OffscreenCanvas without a usable 2D
      // implementation. The DOM-canvas path below preserves the soft caches.
    }
  }

  if (
    canvas.ownerDocument &&
    typeof canvas.ownerDocument.createElement === "function"
  ) {
    try {
      const surface = canvas.ownerDocument.createElement("canvas");
      surface.width = width;
      surface.height = height;
      return supportsSurfaceCanvas(surface) ? surface : null;
    } catch {
      return null;
    }
  }
  return null;
}

function supportsSurfaceCanvas(surface) {
  if (!surface || typeof surface.getContext !== "function") {
    return false;
  }
  try {
    const context = surface.getContext("2d");
    return Boolean(
      context &&
        typeof context.createImageData === "function" &&
        typeof context.putImageData === "function",
    );
  } catch {
    return false;
  }
}

function sampleCellProperty(
  cellIndex,
  dimensions,
  worldX,
  worldY,
  property,
  fallback,
) {
  // data/world.js and the simulation both use the value of the containing
  // cell throughout [x, x + 1) by [y, y + 1). Match that authoritative sample
  // before the purely visual pigment diffusion applied to the cached image.
  return cellValue(
    cellIndex,
    dimensions,
    Math.floor(worldX),
    Math.floor(worldY),
    property,
    fallback,
  );
}

function cellValue(
  cellIndex,
  dimensions,
  x,
  y,
  property,
  fallback,
) {
  const boundedX = clampInteger(x, 0, dimensions.width - 1, 0);
  const boundedY = clampInteger(y, 0, dimensions.height - 1, 0);
  const cell = cellIndex.get(boundedY * dimensions.width + boundedX);
  return cell && Number.isFinite(cell[property])
    ? unit(cell[property], fallback)
    : fallback;
}

function writePixel(data, index, color, alpha) {
  data[index] = clampInteger(Math.round(color[0]), 0, 255, 0);
  data[index + 1] = clampInteger(Math.round(color[1]), 0, 255, 0);
  data[index + 2] = clampInteger(Math.round(color[2]), 0, 255, 0);
  data[index + 3] = clampInteger(Math.round(alpha), 0, 255, 255);
}

function softenSurfaceImage(image, width, height, radius) {
  const data = image && image.data;
  if (
    !(data instanceof Uint8ClampedArray) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    radius <= 0
  ) {
    return;
  }

  const span = radius * 2 + 1;
  const scratch = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let total = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sourceX = clampInteger(x + offset, 0, width - 1, x);
          total += data[(y * width + sourceX) * 4 + channel];
        }
        scratch[targetIndex + channel] = Math.round(total / span);
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let total = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sourceY = clampInteger(y + offset, 0, height - 1, y);
          total += scratch[(sourceY * width + x) * 4 + channel];
        }
        data[targetIndex + channel] = Math.round(total / span);
      }
    }
  }
}

function addSurfacePaperTexture(context, width, height, seed) {
  const fiberCount = clampInteger(
    Math.round((width * height) / 320),
    120,
    950,
    300,
  );
  context.save();
  context.globalCompositeOperation = "multiply";
  context.lineCap = "round";
  for (let index = 0; index < fiberCount; index += 1) {
    const x = hashUnit(seed, index, 503) * width;
    const y = hashUnit(seed, index, 509) * height;
    const length = 3 + hashUnit(seed, index, 521) * 18;
    const angle =
      (hashUnit(seed, index, 523) - 0.5) * 0.28;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
    );
    context.strokeStyle =
      "rgba(91, 84, 63, " +
      (0.018 + hashUnit(seed, index, 541) * 0.028) +
      ")";
    context.lineWidth = 0.35 + hashUnit(seed, index, 547) * 0.55;
    context.stroke();
  }

  const fleckCount = Math.floor(fiberCount * 0.7);
  for (let index = 0; index < fleckCount; index += 1) {
    const x = hashUnit(seed, index, 557) * width;
    const y = hashUnit(seed, index, 563) * height;
    const radius = 0.25 + hashUnit(seed, index, 569) * 1.1;
    context.fillStyle =
      "rgba(91, 84, 63, " +
      (0.018 + hashUnit(seed, index, 571) * 0.025) +
      ")";
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();
  }
  context.restore();
}

function addSuitabilityGranulation(context, width, height, seed) {
  const count = clampInteger(
    Math.round((width * height) / 720),
    60,
    420,
    150,
  );
  context.save();
  context.globalCompositeOperation = "multiply";
  for (let index = 0; index < count; index += 1) {
    const x = hashUnit(seed, index, 577) * width;
    const y = hashUnit(seed, index, 587) * height;
    const radius = 0.4 + hashUnit(seed, index, 593) * 1.6;
    context.fillStyle =
      "rgba(55, 91, 76, " +
      (0.018 + hashUnit(seed, index, 599) * 0.025) +
      ")";
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();
  }
  context.restore();
}

function createAmbientTrees(world, dimensions, maximum) {
  if (maximum <= 0) {
    return [];
  }
  const candidates = [];
  const seed = finiteInteger(world.seed, 0);
  for (const cell of world.cells) {
    if (
      !cell ||
      !Number.isInteger(cell.x) ||
      !Number.isInteger(cell.y) ||
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= dimensions.width ||
      cell.y >= dimensions.height
    ) {
      continue;
    }
    const density = unit(cell.ambientDensity, 0);
    const appearance = hashUnit(seed, cell.x, cell.y, 601);
    if (appearance > density * 0.43) {
      continue;
    }
    const visualSeed = hash32(
      seed ^
        Math.imul(cell.x + 1, 0x27d4eb2d) ^
        Math.imul(cell.y + 1, 0x165667b1),
    );
    const stageRoll = hashUnit(visualSeed, 1, 607);
    candidates.push({
      id: "ambient-" + cell.x + "-" + cell.y,
      x: cell.x + 0.12 + hashUnit(visualSeed, 2, 613) * 0.76,
      y: cell.y + 0.12 + hashUnit(visualSeed, 3, 617) * 0.76,
      age: stageRoll < 0.18 ? 5 : 24,
      size: 0.72 + hashUnit(visualSeed, 4, 619) * 0.65,
      vitality: 0.68 + hashUnit(visualSeed, 5, 631) * 0.3,
      stage: stageRoll < 0.18 ? "sapling" : "mature",
      managed: false,
      founder: false,
      alive: true,
      visualSeed,
      priority: hashUnit(visualSeed, 6, 641),
      revealPriority: hashUnit(visualSeed, 7, 647),
    });
  }

  candidates.sort((left, right) => left.priority - right.priority);
  return candidates.slice(0, maximum);
}

function entityVisualSeed(entity, salt) {
  let seed = salt >>> 0;
  if (entity && entity.id !== undefined && entity.id !== null) {
    seed ^= hashText(String(entity.id));
  }
  if (entity && Number.isFinite(entity.x)) {
    seed ^= Math.imul(Math.round(entity.x * 1000), 0x27d4eb2d);
  }
  if (entity && Number.isFinite(entity.y)) {
    seed ^= Math.imul(Math.round(entity.y * 1000), 0x165667b1);
  }
  return hash32(seed);
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash32(hash);
}

function hashUnit(a, b, c, d = 0) {
  let value = finiteInteger(a, 0) >>> 0;
  value ^= Math.imul(finiteInteger(b, 0), 0x9e3779b1);
  value ^= Math.imul(finiteInteger(c, 0), 0x85ebca6b);
  value ^= Math.imul(finiteInteger(d, 0), 0xc2b2ae35);
  return hash32(value) / UINT32_RANGE;
}

function hash32(value) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function suitabilityColor(value) {
  if (value <= 0.5) {
    return mixRgb([144, 149, 166], [194, 181, 112], value * 2);
  }
  return mixRgb([194, 181, 112], [72, 126, 101], (value - 0.5) * 2);
}

function rgba(color, alpha) {
  return (
    "rgba(" +
    Math.round(color[0]) +
    ", " +
    Math.round(color[1]) +
    ", " +
    Math.round(color[2]) +
    ", " +
    clamp(alpha, 0, 1) +
    ")"
  );
}

function mixRgb(start, end, amount) {
  const t = clamp(amount, 0, 1);
  return [
    lerp(start[0], end[0], t),
    lerp(start[1], end[1], t),
    lerp(start[2], end[2], t),
  ];
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function finiteInteger(value, fallback) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function unit(value, fallback) {
  return clamp(finiteOr(value, fallback), 0, 1);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function smoothRange(start, end, value) {
  if (end <= start) {
    return value >= end ? 1 : 0;
  }
  const amount = clamp((value - start) / (end - start), 0, 1);
  return amount * amount * (3 - 2 * amount);
}
