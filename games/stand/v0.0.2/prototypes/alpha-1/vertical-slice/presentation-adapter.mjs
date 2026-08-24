export function createPresentationSnapshot(domain, worldView, revision = 1) {
  const state = domain.inspect({ type: "state" });
  const sites = new Map(worldView.sitePreview.map((site) => [site.hex_id, site]));
  const project = createPositionProjector(worldView.sitePreview);
  const metresToView = project.metresToView;
  const point = (record) => record?.position
    ? project(record.position)
    : sites.get(record?.cellId) ?? sites.get(worldView.selectedFounderSiteId);
  const cellPoint = (cellId) => sites.get(cellId) ?? sites.get(worldView.selectedFounderSiteId);
  const seedSource = (seed) => {
    const source = state.livingTrees.find(({ id }) => id === seed.sourceEntityId)
      ?? state.cohorts.find(({ id }) => id === seed.sourceEntityId);
    return source ? point(source) : cellPoint(seed.cellId);
  };
  const individuals = [
    ...state.livingTrees.map((tree) => livingTree(tree, point(tree), metresToView)),
    ...state.recruits.map((recruit) => recruitTree(recruit, point(recruit), metresToView)),
    ...state.snags.map((snag) => deadRecord(snag, point(snag), "snag", metresToView)),
    ...state.deadwood.map((deadwood) => deadRecord(deadwood, point(deadwood), "deadwood", metresToView)),
  ];
  const cohorts = state.cohorts.map((cohort) => ({
    id: cohort.id,
    kind: "cohort",
    speciesId: cohort.managementClass === "managed" ? "acer-saccharum" : null,
    relationship: cohort.managementClass,
    state: cohort.stage === "senescent" ? "mortality" : "living",
    x: point(cohort).viewX,
    y: point(cohort).viewY,
    radiusX: metresToView(Math.max(3, Math.sqrt(cohort.stemCount) * 2.8)),
    radiusY: metresToView(Math.max(2.2, Math.sqrt(cohort.stemCount) * 2.05)),
    vitality: cohort.stage === "senescent" ? 0.48 : 0.82,
    canopyLight: state.cellState.find(({ cellId }) => cellId === cohort.cellId)?.availableLight01 ?? 0.5,
    gap: false,
  }));
  // Far/stand presentation follows persistent entity positions. Hidden ecology
  // cells remain bookkeeping only and never become one visible patch per cell.
  const canopyPatches = [...state.livingTrees, ...state.cohorts]
    .filter((record) => record.canopyPressure01 > 0.0001)
    .map((record) => ({
    id: `patch-${record.id}`,
    kind: "canopy-patch",
    speciesId: "acer-saccharum",
    relationship: record.managementClass,
    x: point(record).viewX,
    y: point(record).viewY,
    radiusX: Math.max(0.035, 0.025 + record.canopyPressure01 * 0.11),
    radiusY: Math.max(0.025, 0.018 + record.canopyPressure01 * 0.08),
    cover: record.canopyPressure01,
    mortality: 0,
    gap: false,
  }));
  return {
    schema: "stand-presentation-snapshot@1",
    fixtureId: `oneida-real-${worldView.sourcePackage.manifestSha256.slice(0, 12)}`,
    revision,
    forestTimeYears: state.clock.syntheticYears,
    rp: state.rp.balance,
    individuals,
    cohorts,
    canopyPatches,
    seeds: state.propagules.map((seed) => {
      const source = seedSource(seed);
      const target = point(seed);
      return {
        id: seed.id,
        sourceX: source.viewX,
        sourceY: source.viewY,
        targetX: target.viewX,
        targetY: target.viewY,
        presentationBornAtMs: state.clock.step * 1000,
      };
    }),
    feedback: [],
    events: state.events.map((event) => ({
      id: event.eventId,
      order: event.sequence,
      forestTimeYears: event.step,
      type: event.type,
      tone: event.reasonCode ? "warning" : "info",
      message: event.reasonCode ? `${event.type}: ${event.reasonCode}` : event.type.replaceAll("-", " "),
    })),
    authority: {
      ecologicalSpecies: ["acer-saccharum"],
      ambientArtFamilies: "presentation-only-not-in-this-snapshot",
      worldPackageManifestSha256: worldView.sourcePackage.manifestSha256,
    },
  };
}

function createPositionProjector(sourceSites) {
  const sites = sourceSites.filter((site) =>
    [site.kernelX, site.kernelY, site.viewX, site.viewY].every(Number.isFinite),
  );
  let basis = null;
  for (let first = 0; first < sites.length - 2; first += 1) {
    for (let second = first + 1; second < sites.length - 1; second += 1) {
      for (let third = second + 1; third < sites.length; third += 1) {
        const candidate = [sites[first], sites[second], sites[third]];
        const determinant =
          (candidate[1].kernelX - candidate[0].kernelX) * (candidate[2].kernelY - candidate[0].kernelY) -
          (candidate[1].kernelY - candidate[0].kernelY) * (candidate[2].kernelX - candidate[0].kernelX);
        if (!basis || Math.abs(determinant) > Math.abs(basis.determinant)) {
          basis = { sites: candidate, determinant };
        }
      }
    }
  }
  if (basis && Math.abs(basis.determinant) > 1e-9) {
    const [origin, xBasis, yBasis] = basis.sites;
    const viewDeterminant =
      (xBasis.viewX - origin.viewX) * (yBasis.viewY - origin.viewY) -
      (xBasis.viewY - origin.viewY) * (yBasis.viewX - origin.viewX);
    const viewUnitsPerKernelUnit = Math.sqrt(Math.abs(viewDeterminant / basis.determinant));
    const project = (position) => {
      const px = position.x - origin.kernelX;
      const py = position.y - origin.kernelY;
      const bx = xBasis.kernelX - origin.kernelX;
      const by = xBasis.kernelY - origin.kernelY;
      const cx = yBasis.kernelX - origin.kernelX;
      const cy = yBasis.kernelY - origin.kernelY;
      const u = (px * cy - py * cx) / basis.determinant;
      const v = (bx * py - by * px) / basis.determinant;
      return {
        viewX: origin.viewX + u * (xBasis.viewX - origin.viewX) + v * (yBasis.viewX - origin.viewX),
        viewY: origin.viewY + u * (xBasis.viewY - origin.viewY) + v * (yBasis.viewY - origin.viewY),
      };
    };
    return withPhysicalScale(project, viewUnitsPerKernelUnit);
  }
  const origin = sites[0];
  if (!origin) return withPhysicalScale(() => ({ viewX: 0, viewY: 0 }), 1);
  const end = sites.slice(1).sort((left, right) =>
    ((right.kernelX - origin.kernelX) ** 2 + (right.kernelY - origin.kernelY) ** 2) -
    ((left.kernelX - origin.kernelX) ** 2 + (left.kernelY - origin.kernelY) ** 2),
  )[0];
  if (!end) return withPhysicalScale((position) => ({
    viewX: origin.viewX + position.x - origin.kernelX,
    viewY: origin.viewY + position.y - origin.kernelY,
  }), 1);
  const kernelDx = end.kernelX - origin.kernelX;
  const kernelDy = end.kernelY - origin.kernelY;
  const kernelLength = Math.hypot(kernelDx, kernelDy);
  const viewDx = end.viewX - origin.viewX;
  const viewDy = end.viewY - origin.viewY;
  const viewLength = Math.hypot(viewDx, viewDy);
  const scale = viewLength / kernelLength;
  const project = (position) => {
    const dx = position.x - origin.kernelX;
    const dy = position.y - origin.kernelY;
    const along = (dx * kernelDx + dy * kernelDy) / kernelLength;
    const across = (-dx * kernelDy + dy * kernelDx) / kernelLength;
    const viewUnitX = viewDx / viewLength;
    const viewUnitY = viewDy / viewLength;
    return {
      viewX: origin.viewX + (along * viewUnitX - across * viewUnitY) * scale,
      viewY: origin.viewY + (along * viewUnitY + across * viewUnitX) * scale,
    };
  };
  return withPhysicalScale(project, scale);
}

// Kernel local coordinates use 100-metre units. Physical tree dimensions must
// be projected through the same affine map as their positions; otherwise a
// 16-metre tree is accidentally interpreted as 16 county-view units.
function withPhysicalScale(project, viewUnitsPerKernelUnit) {
  const scale = Number.isFinite(viewUnitsPerKernelUnit) && viewUnitsPerKernelUnit > 0
    ? viewUnitsPerKernelUnit
    : 1;
  project.metresToView = (metres) => Number(metres) * scale / 100;
  return project;
}

function livingTree(tree, site, metresToView) {
  return {
    id: tree.id,
    kind: "tree",
    speciesId: "acer-saccharum",
    relationship: tree.managementClass,
    state: "living",
    stage: tree.stage,
    x: site.viewX,
    y: site.viewY,
    height: metresToView(2 + tree.size01 * 14),
    crownRadius: metresToView(0.8 + tree.size01 * 4.4),
    vitality: Math.max(0.35, tree.development01),
    foliage: Math.max(0.35, tree.development01),
    featured: tree.founder,
    seedSourceEligible: tree.reproductive === true,
  };
}

function recruitTree(recruit, site, metresToView) {
  return {
    id: recruit.id,
    kind: "tree",
    speciesId: "acer-saccharum",
    relationship: recruit.managementClass,
    state: "living",
    stage: "recruit",
    x: site.viewX,
    y: site.viewY,
    height: metresToView(0.8 + recruit.development01 * 2),
    crownRadius: metresToView(0.45 + recruit.development01),
    vitality: recruit.suppressed ? 0.48 : 0.75,
    foliage: recruit.suppressed ? 0.38 : 0.68,
    suppressed: recruit.suppressed,
    released: recruit.releaseProgress01 > 0,
    seedSourceEligible: false,
  };
}

function deadRecord(record, site, kind, metresToView) {
  return {
    id: record.id,
    kind,
    speciesId: "acer-saccharum",
    relationship: record.managementClass,
    state: kind === "snag" ? "dead" : "down",
    x: site.viewX,
    y: site.viewY,
    height: metresToView(6),
    crownRadius: 0,
    vitality: 0,
    foliage: 0,
  };
}
