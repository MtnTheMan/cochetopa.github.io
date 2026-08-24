import { nextSemanticBand, semanticWeights } from "./semantic-zoom.js";
import { getArtFamily } from "./ambient-visual-layer.js";

export function sortByProjectedDepth(drawables, depthOf) {
  return [...drawables].sort((left, right) => {
    const depth = depthOf(left) - depthOf(right);
    if (Math.abs(depth) > 1e-9) return depth;
    const typeOrder = { ambient: 0, cohort: 1, individual: 2 };
    const type = (typeOrder[left.type] ?? 9) - (typeOrder[right.type] ?? 9);
    if (type) return type;
    return String(left.entity?.id ?? left.id).localeCompare(String(right.entity?.id ?? right.id));
  });
}

export function ambientCrownRadiusPx(projectionScale, zoom, crownScale = 1) {
  return clamp(projectionScale * 0.0085 * crownScale, 1.7, zoom >= 70 ? 18 : 12);
}

export function managedCrownRadiusPx(crownRadius, projectionScale) {
  return clamp((crownRadius || 0.008) * projectionScale * 2, 3, 106);
}

const CONFIG = Object.freeze({ closeIsoY: 0.36, farIsoY: 1, padding: 1.13, maxDpr: 2 });
const COLORS = Object.freeze({
  paper: "#eee9d8", paperLight: "#f7f3e2", ink: "#26342d",
  land: "#b8bda2", landLight: "#d7d7bc", water: "#8eb5b0",
  wetland: "#a8bab0", managed: "#567d4e", managedLight: "#87a966",
  ambient: "#94a18e", ambientLight: "#bcc2aa", stress: "#a66f48",
  dead: "#756653", seed: "#bd8644", sun: "#e9bd5b", rain: "#6b9aa0",
});

export function createRenderer(canvas, fixture, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") throw new TypeError("A canvas is required.");
  const context = canvas.getContext("2d", { alpha: false, desynchronized: options.desynchronized !== false }) || canvas.getContext("2d");
  if (!context) throw new TypeError("Canvas 2D is unavailable.");
  const assets = options.assets || {};
  const ambientVisualLayer = options.ambientVisualLayer || null;
  const now = typeof options.now === "function" ? options.now : () => performance.now();
  const metrics = { width: 1, height: 1, dpr: 1, fit: 1 };
  let semanticBand = "stand";
  let destroyed = false;
  let lastFrame = Object.freeze({ band: semanticBand, durationMs: 0, visible: {}, drawCalls: 0 });

  function resize() {
    if (destroyed) return { ...metrics };
    const rect = canvas.getBoundingClientRect?.() || {};
    metrics.width = Math.max(1, rect.width || canvas.clientWidth || 960);
    metrics.height = Math.max(1, rect.height || canvas.clientHeight || 640);
    metrics.dpr = Math.min(CONFIG.maxDpr, Math.max(1, options.devicePixelRatio || globalThis.devicePixelRatio || 1));
    const width = Math.round(metrics.width * metrics.dpr);
    const height = Math.round(metrics.height * metrics.dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    metrics.fit = Math.min(
      metrics.width / (fixture.extent.width * CONFIG.padding),
      metrics.height / (fixture.extent.height * CONFIG.farIsoY * CONFIG.padding),
    );
    return { ...metrics };
  }

  function projection(view = {}) {
    const zoom = clamp(Number(view.zoom) || 1, 0.72, 320);
    const rotation = Number(view.rotation) || 0;
    const scale = metrics.fit * zoom;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const centerX = Number.isFinite(view.centerX) ? view.centerX : fixture.extent.width / 2;
    const centerY = Number.isFinite(view.centerY) ? view.centerY : fixture.extent.height / 2;
    const isoY = cameraIsoY(zoom);
    return { zoom, rotation, scale, cos, sin, centerX, centerY, isoY };
  }

  function worldToScreen(x, y, view = {}) {
    const p = projection(view);
    const dx = Number(x) - p.centerX;
    const dy = Number(y) - p.centerY;
    return {
      x: metrics.width / 2 + (dx * p.cos - dy * p.sin) * p.scale,
      y: metrics.height / 2 + (dx * p.sin + dy * p.cos) * p.scale * p.isoY,
    };
  }

  function screenToWorld(x, y, view = {}) {
    const p = projection(view);
    const rx = (Number(x) - metrics.width / 2) / p.scale;
    const ry = (Number(y) - metrics.height / 2) / (p.scale * p.isoY);
    const dx = rx * p.cos + ry * p.sin;
    const dy = -rx * p.sin + ry * p.cos;
    const worldX = p.centerX + dx;
    const worldY = p.centerY + dy;
    return {
      x: worldX,
      y: worldY,
      inside: worldX >= 0 && worldY >= 0 && worldX <= fixture.extent.width && worldY <= fixture.extent.height,
    };
  }

  function render(snapshot, view = {}, presentationTimeMs = 0) {
    if (destroyed) return lastFrame;
    const started = now();
    resizeIfNeeded();
    const p = projection(view);
    semanticBand = nextSemanticBand(semanticBand, p.zoom);
    const weights = semanticWeights(p.zoom);
    let drawCalls = 0;
    const visible = { individuals: 0, cohorts: 0, canopyPatches: 0, ambientVisualAppearances: 0, acceptedArtAppearances: 0, structuralFallbackAppearances: 0, structuralFamilyAppearances: 0, seeds: 0 };

    resetContext(context);
    drawCalls += drawBackdrop(context);
    drawCalls += drawTerrain(context, fixture, view);

    let ambientAppearances = [];
    if (ambientVisualLayer) {
      const appearanceCap = p.zoom < 3 ? 240 : p.zoom < 70 ? 190 : 130;
      const eligibleAppearances = ambientVisualLayer.appearances.filter((appearance) =>
        p.zoom < 3 ? appearance.scope !== "local-stand-context" : p.zoom >= 70 ? appearance.scope !== "county-context" : true,
      );
      ambientAppearances = selectVisible(eligibleAppearances, view, 10, appearanceCap);
    }

    if (weights.far > 0.005) {
      context.save(); context.globalAlpha = weights.far;
      for (const patch of selectVisible(snapshot.canopyPatches || [], view, 22, 240)) {
        drawCanopyPatch(context, patch, view); visible.canopyPatches += 1; drawCalls += 1;
      }
      context.restore();
    }
    const treeDrawables = ambientAppearances.map((appearance) => ({
      type: "ambient", entity: appearance, alpha: p.zoom < 3 ? 0.38 : p.zoom < 70 ? 0.52 : 0.68,
    }));
    if (weights.stand > 0.005) for (const cohort of selectVisible(snapshot.cohorts || [], view, 9, 180)) {
      treeDrawables.push({ type: "cohort", entity: cohort, alpha: weights.stand });
    }
    if (weights.close > 0.005 || p.zoom > 8) {
      const closeAlpha = Math.max(weights.close, smoothstep((logZoom(p.zoom) - logZoom(6)) / (logZoom(70) - logZoom(6))) * weights.stand * 0.55);
      const individualCap = p.zoom >= 70 ? 220 : 64;
      for (const entity of selectVisible(snapshot.individuals || [], view, 7, individualCap)) {
        treeDrawables.push({ type: "individual", entity, alpha: closeAlpha });
      }
    }
    for (const drawable of sortByProjectedDepth(treeDrawables, ({ entity }) => worldToScreen(entity.x, entity.y, view).y)) {
      context.save(); context.globalAlpha = drawable.alpha;
      if (drawable.type === "ambient") {
        const usedAcceptedArt = drawAmbientAppearance(context, drawable.entity, view, p);
        visible.ambientVisualAppearances += 1;
        visible[usedAcceptedArt ? "acceptedArtAppearances" : "structuralFallbackAppearances"] += 1;
        if (!usedAcceptedArt) visible.structuralFamilyAppearances += 1;
      } else if (drawable.type === "cohort") {
        drawCohort(context, drawable.entity, view); visible.cohorts += 1;
      } else {
        drawIndividual(context, drawable.entity, view, p, presentationTimeMs); visible.individuals += 1;
      }
      context.restore(); drawCalls += 1;
    }
    for (const seed of snapshot.seeds || []) {
      drawSeed(context, seed, view, presentationTimeMs); visible.seeds += 1; drawCalls += 1;
    }
    for (const cue of snapshot.feedback || []) { drawFeedback(context, cue, view, presentationTimeMs); drawCalls += 1; }

    lastFrame = Object.freeze({
      schema: "stand-render-frame@1",
      band: semanticBand,
      weights: Object.freeze({ ...weights }),
      durationMs: Math.max(0, now() - started),
      drawCalls,
      visible: Object.freeze(visible),
      hiddenGridLines: 0,
      snapshotRevision: snapshot.revision,
      ambientVisualLayer: ambientVisualLayer ? Object.freeze({
        schema: ambientVisualLayer.schema,
        seed: ambientVisualLayer.seed,
        disposition: ambientVisualLayer.disposition,
        targetFamilyCount: ambientVisualLayer.targetFamilyCount,
        acceptedArtAssetCoverage: ambientVisualLayer.acceptedArtAssetCoverage,
        loadedRuntimeAssetCoverage: ambientVisualLayer.loadedRuntimeAssetCoverage,
        assetBindingStatus: ambientVisualLayer.assetBindingStatus,
        replayDigest: ambientVisualLayer.replayDigest,
      }) : null,
    });
    return lastFrame;
  }

  function hitTest(screenX, screenY, snapshot, view = {}) {
    if (nextSemanticBand(semanticBand, view.zoom) !== "close") return null;
    const candidates = [];
    for (const entity of snapshot.individuals || []) {
      if (entity.kind !== "tree" || entity.state !== "living" || entity.relationship !== "managed") continue;
      const point = worldToScreen(entity.x, entity.y, view);
      const radius = clamp((entity.crownRadius || 1.5) * projection(view).scale, 15, 62);
      const distance = Math.hypot(screenX - point.x, screenY - (point.y - radius * 0.48));
      if (distance <= radius) candidates.push({ entity, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance || String(a.entity.id).localeCompare(String(b.entity.id)));
    return candidates[0]?.entity || null;
  }

  function getLastFrame() { return lastFrame; }
  function destroy() { destroyed = true; }

  resize();
  return Object.freeze({ resize, render, worldToScreen, screenToWorld, hitTest, getLastFrame, destroy });

  function resizeIfNeeded() {
    const rect = canvas.getBoundingClientRect?.();
    const dpr = Math.min(CONFIG.maxDpr, Math.max(1, options.devicePixelRatio || globalThis.devicePixelRatio || 1));
    if (!rect || Math.abs((rect.width || 0) - metrics.width) > 0.5 || Math.abs((rect.height || 0) - metrics.height) > 0.5 || Math.abs(dpr - metrics.dpr) > 0.01) resize();
  }

  function resetContext(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
  }

  function drawBackdrop(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, metrics.height);
    gradient.addColorStop(0, COLORS.paperLight); gradient.addColorStop(1, COLORS.paper);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, metrics.width, metrics.height);
    return 1;
  }

  function drawTerrain(ctx, world, camera) {
    const corners = [[0, 0], [world.extent.width, 0], [world.extent.width, world.extent.height], [0, world.extent.height]].map(([x, y]) => worldToScreen(x, y, camera));
    const boundary = world.boundary?.points?.length ? world.boundary.points.map(([x, y]) => worldToScreen(x, y, camera)) : corners;
    tracePolygon(ctx, boundary); ctx.fillStyle = COLORS.landLight; ctx.fill();
    ctx.save(); tracePolygon(ctx, boundary); ctx.clip();
    const wash = ctx.createRadialGradient(metrics.width * 0.55, metrics.height * 0.46, 20, metrics.width * 0.55, metrics.height * 0.46, metrics.width * 0.65);
    wash.addColorStop(0, "rgba(151,164,120,.65)"); wash.addColorStop(1, "rgba(205,203,171,.25)");
    ctx.fillStyle = wash; ctx.fillRect(0, 0, metrics.width, metrics.height);
    let count = 2;
    count += drawContinuousSiteField(ctx, world.siteFactor, camera);
    for (const body of world.water.bodies) {
      const points = body.polygon.map(([x, y]) => worldToScreen(x, y, camera));
      tracePolygon(ctx, points); ctx.fillStyle = body.kind === "wetland-wash" ? "rgba(139,169,153,.48)" : "rgba(104,157,161,.68)"; ctx.fill(); count += 1;
    }
    for (const stream of world.water.streams) {
      ctx.beginPath(); stream.forEach(([x, y], index) => { const point = worldToScreen(x, y, camera); index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y); });
      ctx.strokeStyle = "rgba(91,145,150,.62)"; ctx.lineWidth = clamp(projection(camera).scale * 0.42, 1, 4); ctx.stroke(); count += 1;
    }
    ctx.restore();
    tracePolygon(ctx, boundary); ctx.strokeStyle = "rgba(64,77,64,.32)"; ctx.lineWidth = 1.2; ctx.stroke();
    return count + 1;
  }

  function drawContinuousSiteField(ctx, siteFactor, camera) {
    if (!siteFactor?.samples?.length) return 0;
    const spacing = nearestSampleSpacing(siteFactor.samples);
    const radius = clamp(spacing * projection(camera).scale * 2.35, 16, 420);
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    for (const [x, y, rawValue] of siteFactor.samples) {
      const value = clamp(Number(rawValue), 0, 1);
      const point = worldToScreen(x, y, camera);
      if (point.x < -radius || point.x > metrics.width + radius || point.y < -radius || point.y > metrics.height + radius) continue;
      const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      const alpha = 0.025 + value * 0.035;
      const red = Math.round(166 - value * 82);
      const green = Math.round(139 - value * 10);
      const blue = Math.round(91 - value * 24);
      gradient.addColorStop(0, `rgba(${red},${green},${blue},${alpha})`);
      gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
    return siteFactor.samples.length;
  }

  function drawCanopyPatch(ctx, patch, camera) {
    const point = worldToScreen(patch.x, patch.y, camera);
    const projected = projection(camera); const scale = projected.scale;
    const managed = patch.relationship === "managed";
    if (patch.gap) {
      ctx.beginPath(); ctx.ellipse(point.x, point.y, patch.radiusX * scale, patch.radiusY * scale * projected.isoY, hashAngle(patch.id) * 0.18, 0, Math.PI * 2);
    } else {
      traceBroadleafCanopy(ctx, point.x, point.y, patch.radiusX * scale, patch.radiusY * scale * projected.isoY, patch.id, "canopy-patch", .82);
    }
    ctx.fillStyle = patch.gap ? "rgba(236,230,205,.44)" : patch.mortality ? "rgba(148,105,70,.52)" : managed ? "rgba(76,116,67,.55)" : "rgba(144,157,137,.45)"; ctx.fill();
    if (managed && !patch.gap) { ctx.strokeStyle = "rgba(38,52,45,.28)"; ctx.lineWidth = clamp(scale * 0.08, 0.5, 1.3); ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]); }
  }

  function drawAmbientAppearance(ctx, appearance, camera, p) {
    const family = getArtFamily(appearance.targetArtFamilyId);
    if (!family) return false;
    const point = worldToScreen(appearance.x, appearance.y, camera);
    const baseRadius = ambientCrownRadiusPx(p.scale, p.zoom, appearance.crownScale);
    const width = baseRadius * family.width;
    const height = baseRadius * family.height * p.isoY;
    const angled = smoothstep((logZoom(p.zoom) - logZoom(2.5)) / (logZoom(70) - logZoom(2.5)));
    const crownLift = baseRadius * (1.34 + family.height * 0.82) * angled;
    ctx.save(); ctx.translate(point.x, point.y);
    ctx.globalAlpha *= appearance.glaze;
    if (angled > 0.04) {
      ctx.strokeStyle = "rgba(91,76,58,.48)";
      ctx.lineWidth = clamp(baseRadius * .105, .65, 3.2);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -crownLift * .78); ctx.stroke();
    }
    ctx.translate(0, -crownLift);
    ctx.rotate(appearance.rotation * (1 - angled * .72));
    const conifer = ["pine", "pine-open", "fir", "spruce", "hemlock", "cedar", "larch"].includes(family.form);
    if (conifer) {
      ctx.fillStyle = family.color;
      drawConiferAppearance(ctx, family.form, width, height, appearance.id);
    } else {
      ctx.fillStyle = family.color;
      drawHardwoodAppearance(ctx, family.form, width, height, appearance.id);
    }
    const botanical = assets.ambientArt?.images?.[family.id];
    const usedAcceptedArt = Boolean(botanical && p.zoom >= 6);
    if (usedAcceptedArt) drawBotanicalMotifs(ctx, botanical, width, height, appearance.id, conifer, p.zoom);
    ctx.restore();
    return usedAcceptedArt;
  }

  function drawConiferAppearance(ctx, form, width, height, id) {
    const tiers = form === "cedar" ? 4 : form === "pine-open" ? 3 : 5;
    const narrow = form === "spruce" || form === "fir" ? 0.72 : form === "cedar" ? 0.58 : 1;
    for (let tier = 0; tier < tiers; tier += 1) {
      const t = tier / Math.max(1, tiers - 1);
      const tierY = -height * 0.55 + t * height * 0.9;
      const tierWidth = width * narrow * (0.32 + t * 0.68) * (form === "pine-open" && tier === 1 ? 0.64 : 1);
      ctx.beginPath();
      ctx.moveTo(hashSigned(`${id}-${tier}-tip`) * tierWidth * .05, tierY - height * .26);
      ctx.lineTo(-tierWidth * .42, tierY - height * .03);
      ctx.lineTo(-tierWidth, tierY + height * .25);
      ctx.lineTo(hashSigned(`${id}-${tier}-mid`) * tierWidth * .08, tierY + height * .14);
      ctx.lineTo(tierWidth, tierY + height * .25);
      ctx.lineTo(tierWidth * .44, tierY - height * .03);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawHardwoodAppearance(ctx, form, width, height, id) {
    const spread = form === "vase" ? .72 : form === "narrow" ? .56 : form === "heart" ? .86 : 1;
    traceBroadleafCanopy(ctx, 0, 0, width * spread, height, id, "ambient-main", .88); ctx.fill();
    ctx.save(); ctx.globalAlpha *= .28;
    traceBroadleafCanopy(ctx, width * .16, height * .16, width * .72 * spread, height * .6, id, "ambient-shade", .76); ctx.fill();
    ctx.restore();
  }

  function drawCohort(ctx, cohort, camera) {
    const point = worldToScreen(cohort.x, cohort.y, camera); const projected = projection(camera); const scale = projected.scale;
    const managed = cohort.relationship === "managed"; const stress = cohort.state === "mortality" || cohort.vitality < 0.55;
    if (cohort.gap) {
      ctx.beginPath(); ctx.ellipse(point.x, point.y, cohort.radiusX * scale, cohort.radiusY * scale * projected.isoY, hashAngle(cohort.id) * 0.12, 0, Math.PI * 2);
    } else {
      traceBroadleafCanopy(ctx, point.x, point.y, cohort.radiusX * scale, cohort.radiusY * scale * projected.isoY, cohort.id, "cohort", clamp(cohort.vitality ?? 1, .28, 1));
    }
    ctx.fillStyle = cohort.gap ? "rgba(240,234,214,.7)" : stress ? "rgba(157,111,72,.62)" : managed ? "rgba(79,122,68,.66)" : "rgba(150,163,143,.58)"; ctx.fill();
    if (managed && !cohort.gap) { ctx.strokeStyle = "rgba(38,52,45,.38)"; ctx.lineWidth = clamp(scale * 0.1, 0.55, 1.5); ctx.stroke(); }
  }

  function drawIndividual(ctx, entity, camera, p, time) {
    const base = worldToScreen(entity.x, entity.y, camera);
    const scale = p.scale; const height = clamp((entity.height || 0.02) * scale * 1.04, 2.2, 160);
    if (entity.kind === "deadwood") {
      ctx.beginPath(); ctx.moveTo(base.x - height * 0.45, base.y + height * 0.08); ctx.lineTo(base.x + height * 0.48, base.y - height * 0.14);
      ctx.strokeStyle = COLORS.dead; ctx.lineWidth = clamp(height * 0.08, 1.2, 7); ctx.stroke(); return;
    }
    const bend = hashSigned(`${entity.id}-trunk`) * height * .06;
    ctx.fillStyle = "rgba(54,64,55,.16)"; ctx.beginPath(); ctx.ellipse(base.x + height * .08, base.y + 1, height * .22, height * .055, -.08, 0, Math.PI * 2); ctx.fill();
    drawTaperedTrunk(ctx, base, height, bend, entity.state === "dead");
    if (entity.kind === "snag" || entity.state === "dead") {
      ctx.beginPath(); ctx.moveTo(base.x, base.y - height * 0.62); ctx.lineTo(base.x - height * 0.16, base.y - height * 0.48); ctx.moveTo(base.x, base.y - height * 0.78); ctx.lineTo(base.x + height * 0.14, base.y - height * 0.64); ctx.stroke(); return;
    }
    const crownRadius = managedCrownRadiusPx(entity.crownRadius, scale);
    const centerY = base.y - height * 0.82;
    ctx.save(); ctx.translate(base.x + bend * .25, centerY);
    const ambient = entity.relationship !== "managed";
    const stressed = entity.vitality < 0.62;
    const fullness = clamp(entity.foliage ?? 1, 0.2, 1);
    const main = stressed ? "rgba(164,108,68,.72)" : ambient ? "rgba(147,162,143,.68)" : "rgba(76,121,64,.82)";
    const shade = stressed ? "rgba(116,74,52,.24)" : ambient ? "rgba(91,117,98,.19)" : "rgba(38,79,51,.28)";
    const light = stressed ? "rgba(198,142,80,.28)" : ambient ? "rgba(197,204,171,.26)" : "rgba(151,174,82,.34)";
    traceBroadleafCanopy(ctx, 0, 0, crownRadius, crownRadius * .82, entity.id, "main", fullness); ctx.fillStyle = main; ctx.fill();
    drawCrownLobes(ctx, crownRadius, entity.id, fullness, main, shade, light);
    if (!ambient && assets.foliage && p.zoom >= 6) drawBotanicalMotifs(ctx, assets.foliage, crownRadius * 1.55, crownRadius * 1.3, entity.id, false, p.zoom);
    ctx.strokeStyle = "rgba(111,84,57,.42)"; ctx.lineWidth = clamp(crownRadius * .018, .55, 1.25); ctx.beginPath();
    ctx.moveTo(0, crownRadius * .48); ctx.quadraticCurveTo(-crownRadius * .08, crownRadius * .08, -crownRadius * .48, -crownRadius * .12);
    ctx.moveTo(0, crownRadius * .32); ctx.quadraticCurveTo(crownRadius * .12, 0, crownRadius * .43, -crownRadius * .22); ctx.stroke();
    if (!ambient) {
      traceBroadleafCanopy(ctx, 0, 0, crownRadius, crownRadius * .82, entity.id, "main", fullness);
      ctx.strokeStyle = "rgba(31,42,36,.68)"; ctx.lineWidth = clamp(crownRadius * 0.025, 0.65, 1.8); ctx.stroke();
      drawPigmentSpeckle(ctx, crownRadius, entity.id, stressed ? "rgba(91,57,42,.18)" : "rgba(37,75,48,.16)");
    }
    if (entity.suppressed) {
      ctx.strokeStyle = entity.released ? "rgba(225,184,77,.85)" : "rgba(78,92,74,.75)"; ctx.setLineDash(entity.released ? [] : [2, 3]); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, crownRadius + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawSeed(ctx, seed, camera, time) {
    const age = clamp((time - seed.presentationBornAtMs) / 2200, 0, 1);
    const x = mix(seed.sourceX, seed.targetX, age); const y = mix(seed.sourceY, seed.targetY, age);
    const point = worldToScreen(x, y, camera); const size = clamp(projection(camera).scale * 1.5, 10, 32);
    const flutter = Math.sin(age * Math.PI * 10 + hashAngle(seed.id) * Math.PI * 2) * size * .18;
    ctx.save(); ctx.translate(point.x + flutter, point.y - Math.sin(age * Math.PI) * 42); ctx.rotate(age * Math.PI * 12 + hashAngle(seed.id));
    if (assets.samara) ctx.drawImage(assets.samara, -size / 2, -size / 2, size, size * 0.64);
    else { ctx.strokeStyle = COLORS.seed; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-size * .4, 0); ctx.lineTo(0, size * .12); ctx.lineTo(size * .4, 0); ctx.stroke(); }
    ctx.restore();
  }

  function drawFeedback(ctx, cue, camera, time) {
    if (cue.type === "seed-aim") {
      const source = worldToScreen(cue.sourceX, cue.sourceY, camera);
      const target = worldToScreen(cue.targetX, cue.targetY, camera);
      const angle = Math.atan2(target.y - source.y, target.x - source.x);
      ctx.save(); ctx.strokeStyle = cue.ready ? "rgba(189,134,68,.92)" : "rgba(38,52,45,.58)";
      ctx.fillStyle = cue.ready ? "rgba(189,134,68,.18)" : "rgba(38,52,45,.1)";
      ctx.lineWidth = cue.ready ? 2.2 : 1.4; ctx.setLineDash(cue.ready ? [9, 6] : [4, 6]);
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(target.x, target.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(target.x, target.y, cue.ready ? 11 : 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (cue.ready) {
        ctx.beginPath(); ctx.moveTo(target.x, target.y);
        ctx.lineTo(target.x - Math.cos(angle - .48) * 15, target.y - Math.sin(angle - .48) * 15);
        ctx.moveTo(target.x, target.y);
        ctx.lineTo(target.x - Math.cos(angle + .48) * 15, target.y - Math.sin(angle + .48) * 15); ctx.stroke();
      }
      ctx.restore(); return;
    }
    const age = clamp((time - cue.presentationBornAtMs) / 900, 0, 1); if (age >= 1) return;
    const point = worldToScreen(cue.x, cue.y, camera); ctx.save(); ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = cue.type === "nurture" ? COLORS.rain : COLORS.stress; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(point.x, point.y - 22 - age * 16, 10 + age * 12, 0, Math.PI * 2); ctx.stroke();
    if (cue.type === "nurture") { ctx.fillStyle = COLORS.sun; ctx.beginPath(); ctx.arc(point.x + 14, point.y - 34, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  function isVisible(entity, camera, margin) {
    const point = worldToScreen(entity.x, entity.y, camera);
    return point.x > -margin * 10 && point.x < metrics.width + margin * 10 && point.y > -margin * 10 && point.y < metrics.height + margin * 10;
  }

  function selectVisible(entities, camera, margin, cap) {
    const centerX = camera.centerX ?? fixture.extent.width / 2;
    const centerY = camera.centerY ?? fixture.extent.height / 2;
    return entities
      .filter((entity) => isVisible(entity, camera, margin))
      .sort((left, right) => {
        const leftFeatured = left.featured ? -1 : 0; const rightFeatured = right.featured ? -1 : 0;
        if (leftFeatured !== rightFeatured) return leftFeatured - rightFeatured;
        const leftDistance = Math.hypot(left.x - centerX, left.y - centerY); const rightDistance = Math.hypot(right.x - centerX, right.y - centerY);
        if (Math.abs(leftDistance - rightDistance) > 0.001) return leftDistance - rightDistance;
        return hashAngle(left.id) - hashAngle(right.id);
      })
      .slice(0, cap);
  }
}

function tracePolygon(ctx, points) { ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); }
function drawTaperedTrunk(ctx, base, height, bend, dead) {
  const baseWidth = clamp(height * .055, 1.1, 9);
  const topWidth = baseWidth * .28;
  const topX = base.x + bend * .34;
  const topY = base.y - height;
  ctx.beginPath();
  ctx.moveTo(base.x - baseWidth, base.y);
  ctx.quadraticCurveTo(base.x + bend - baseWidth * .35, base.y - height * .5, topX - topWidth, topY);
  ctx.lineTo(topX + topWidth, topY);
  ctx.quadraticCurveTo(base.x + bend + baseWidth * .28, base.y - height * .5, base.x + baseWidth, base.y);
  ctx.closePath();
  ctx.fillStyle = dead ? COLORS.dead : "rgba(104,78,53,.9)";
  ctx.fill();
  ctx.strokeStyle = dead ? "rgba(67,58,49,.62)" : "rgba(63,49,38,.72)";
  ctx.lineWidth = clamp(height * .012, .55, 1.4);
  ctx.stroke();
  if (height < 34) return;
  ctx.beginPath();
  ctx.moveTo(base.x - baseWidth * .22, base.y - height * .06);
  ctx.quadraticCurveTo(base.x + bend * .24, base.y - height * .46, topX - topWidth * .18, topY + height * .14);
  ctx.moveTo(base.x + baseWidth * .4, base.y - height * .12);
  ctx.quadraticCurveTo(base.x + bend * .72, base.y - height * .52, topX + topWidth * .2, topY + height * .28);
  ctx.strokeStyle = dead ? "rgba(204,188,157,.18)" : "rgba(214,188,137,.24)";
  ctx.lineWidth = clamp(height * .006, .35, .8);
  ctx.stroke();
}
function drawCrownLobes(ctx, radius, id, fullness, main, shade, light) {
  const lobes = [
    [-.02, -.48, .42, .42, "light"],
    [-.39, -.28, .43, .39, "main"],
    [.4, -.25, .45, .4, "light"],
    [-.58, .03, .42, .36, "main"],
    [.59, .04, .44, .37, "shade"],
    [-.38, .3, .47, .35, "shade"],
    [.38, .31, .48, .36, "main"],
    [0, .12, .58, .5, "main"],
  ];
  for (let index = 0; index < lobes.length; index += 1) {
    const [x, y, rx, ry, tone] = lobes[index];
    traceBroadleafCanopy(ctx, x * radius, y * radius, rx * radius, ry * radius, id, `lobe-${index}`, fullness);
    ctx.fillStyle = tone === "shade" ? shade : tone === "light" ? light : main;
    ctx.fill();
  }
}
function traceBroadleafCanopy(ctx, x, y, radiusX, radiusY, id, salt, fullness = 1) {
  const count = radiusX < 7 ? 11 : 19;
  const points = [];
  const phase = hashAngle(`${id}-${salt}-phase`) * Math.PI * 2;
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + index / count * Math.PI * 2;
    const scallop = (index % 2 ? -.055 : .075) + Math.sin(angle * 3 + phase) * .075 + Math.cos(angle * 5 - phase) * .045;
    const irregularity = clamp(.83 + scallop + hashSigned(`${id}-${salt}-${index}`) * .12, .62, 1.14);
    const droop = Math.sin(angle) > 0 ? (1 - fullness) * radiusY * .36 : 0;
    points.push({
      x: x + Math.cos(angle) * radiusX * irregularity,
      y: y + Math.sin(angle) * radiusY * irregularity + droop,
    });
  }
  const last = points.at(-1); const first = points[0];
  ctx.beginPath(); ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]; const next = points[(index + 1) % points.length];
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  ctx.closePath();
}
function traceOrganicCrown(ctx, x, y, radiusX, radiusY, id, salt, fullness = 1) {
  const count = radiusX < 7 ? 9 : 13;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + index / count * Math.PI * 2;
    const irregularity = .78 + hashAngle(`${id}-${salt}-${index}`) * .3;
    const droop = Math.sin(angle) > 0 ? (1 - fullness) * radiusY * .34 : 0;
    points.push({
      x: x + Math.cos(angle) * radiusX * irregularity,
      y: y + Math.sin(angle) * radiusY * irregularity + droop,
    });
  }
  const last = points.at(-1); const first = points[0];
  ctx.beginPath(); ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]; const next = points[(index + 1) % points.length];
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  ctx.closePath();
}
function drawPigmentSpeckle(ctx, radius, id, color) {
  ctx.save(); ctx.fillStyle = color;
  const count = radius > 30 ? 9 : 5;
  for (let index = 0; index < count; index += 1) {
    const angle = hashAngle(`${id}-pigment-angle-${index}`) * Math.PI * 2;
    const distance = Math.sqrt(hashAngle(`${id}-pigment-distance-${index}`)) * radius * .64;
    const size = .45 + hashAngle(`${id}-pigment-size-${index}`) * Math.max(.7, radius * .04);
    ctx.beginPath(); ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance * .7, size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function drawBotanicalMotifs(ctx, image, width, height, id, conifer, zoom) {
  const count = zoom >= 70 ? 3 : 1;
  ctx.save();
  ctx.globalAlpha *= zoom >= 70 ? .74 : .5;
  for (let index = 0; index < count; index += 1) {
    const scale = conifer ? .76 : index === 0 ? .72 : .48;
    const x = count === 1 ? 0 : hashSigned(`${id}-motif-x-${index}`) * width * .22;
    const y = count === 1 ? 0 : hashSigned(`${id}-motif-y-${index}`) * height * .2;
    const motifWidth = Math.max(5, width * scale);
    const motifHeight = Math.max(5, height * scale);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(hashSigned(`${id}-motif-rotation-${index}`) * .38);
    ctx.drawImage(image, -motifWidth / 2, -motifHeight / 2, motifWidth, motifHeight);
    ctx.restore();
  }
  ctx.restore();
}
function hashAngle(value) { let hash = 2166136261; for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0) / 4294967296; }
function hashSigned(value) { return hashAngle(value) * 2 - 1; }
function nearestSampleSpacing(samples) {
  if (samples.length < 2) return 18;
  let nearest = Number.POSITIVE_INFINITY;
  for (let left = 0; left < samples.length - 1; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const distance = Math.hypot(samples[left][0] - samples[right][0], samples[left][1] - samples[right][1]);
      if (distance > 1e-9) nearest = Math.min(nearest, distance);
    }
  }
  return Number.isFinite(nearest) ? nearest : 18;
}
function mix(a, b, t) { return a + (b - a) * t; }
function logZoom(value) { return Math.log(Math.max(.001, value)); }
export function cameraIsoY(zoom) {
  const tilt = smoothstep((logZoom(zoom) - logZoom(2.5)) / (logZoom(70) - logZoom(2.5)));
  return mix(CONFIG.farIsoY, CONFIG.closeIsoY, tilt);
}
function smoothstep(value) { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
