export const ONEIDA_FIXTURE = deepFreeze({
  schema: "stand-render-fixture@1",
  id: "oneida-render-synthetic-v1",
  disposition: "synthetic_only",
  geography: {
    name: "Oneida County, Wisconsin",
    fips: "55085",
    role: "v0.0.2 packaging and test context only",
    containsRealCountyValues: false,
    ecologicalBoundary: false,
  },
  spatialBasis: {
    coordinateFrame: "fixture-normalized-local",
    horizontalUnit: "normalized_fixture_unit",
    selectedCrs: null,
    selectedAnalysisGrid: null,
    selectedRuntimeLattice: null,
  },
  extent: { width: 120, height: 92 },
  terrain: {
    elevationRangeM: [120, 141],
    // Sparse synthetic samples are interpolated into a continuous presentation wash.
    samples: [
      [0, 0, 120], [0.25, 0, 123], [0.5, 0, 127], [0.75, 0, 130], [1, 0, 129],
      [0, 0.33, 122], [0.25, 0.33, 126], [0.5, 0.33, 132], [0.75, 0.33, 135], [1, 0.33, 133],
      [0, 0.66, 124], [0.25, 0.66, 129], [0.5, 0.66, 136], [0.75, 0.66, 141], [1, 0.66, 137],
      [0, 1, 121], [0.25, 1, 125], [0.5, 1, 130], [0.75, 1, 134], [1, 1, 132],
    ],
  },
  water: {
    role: "synthetic hydrography presentation context",
    bodies: [
      {
        id: "lake-synthetic-1",
        kind: "open-water",
        polygon: [[78, 5], [102, 8], [114, 20], [109, 34], [91, 39], [76, 31], [70, 18]],
      },
      {
        id: "wetland-synthetic-1",
        kind: "wetland-wash",
        polygon: [[4, 65], [18, 58], [34, 63], [39, 78], [26, 89], [8, 86]],
      },
    ],
    streams: [
      [[82, 34], [75, 43], [66, 49], [56, 55], [47, 66], [40, 80], [35, 92]],
    ],
  },
  sourceCopy: {
    compact: "Stand-scale fixture · Oneida pilot context",
    detail: "Oneida County, Wisconsin is the v0.0.2 packaging and test context. This finite fixture contains no measured county values and is not a validated county simulation.",
  },
});

export const DENSITY_BANDS = deepFreeze({
  "close-featured": {
    id: "close-featured",
    description: "Featured founder and nearby individuals with light cohort context",
    individuals: 192,
    cohorts: 24,
    canopyPatches: 12,
    camera: { centerX: 57, centerY: 48, zoom: 100, rotation: -0.24 },
  },
  "stand-cohorts": {
    id: "stand-cohorts",
    description: "Bounded individual retention with dense simplified cohort crowns",
    individuals: 384,
    cohorts: 768,
    canopyPatches: 64,
    camera: { centerX: 60, centerY: 47, zoom: 20, rotation: 0.34 },
  },
  "far-canopy-field": {
    id: "far-canopy-field",
    description: "Sparse retained identities over dense far canopy field patches",
    individuals: 96,
    cohorts: 192,
    canopyPatches: 512,
    camera: { centerX: 60, centerY: 46, zoom: 0.88, rotation: -0.12 },
  },
});

// A complete 12-second out-and-back semantic-zoom cycle at 60 samples/second.
// It changes camera presentation only and is deterministic for a fixed snapshot.
export const CAMERA_CYCLE = deepFreeze({
  id: "renderer-refine-coarsen-v1",
  durationMs: 12_000,
  sampleCount: 721,
  start: { centerX: 57, centerY: 48, zoom: 100, rotation: -0.24 },
  far: { centerX: 60, centerY: 46, zoom: 0.88, rotation: 0.44 },
});

export function cameraAtCycleSample(sampleIndex) {
  const index = clamp(Math.trunc(Number(sampleIndex) || 0), 0, CAMERA_CYCLE.sampleCount - 1);
  const t = index / (CAMERA_CYCLE.sampleCount - 1);
  const outward = t <= 0.5 ? t * 2 : (1 - t) * 2;
  const eased = smoothstep(outward);
  return {
    centerX: mix(CAMERA_CYCLE.start.centerX, CAMERA_CYCLE.far.centerX, eased),
    centerY: mix(CAMERA_CYCLE.start.centerY, CAMERA_CYCLE.far.centerY, eased),
    zoom: Math.exp(mix(Math.log(CAMERA_CYCLE.start.zoom), Math.log(CAMERA_CYCLE.far.zoom), eased)),
    rotation: mix(CAMERA_CYCLE.start.rotation, CAMERA_CYCLE.far.rotation, eased),
  };
}

export function createDensitySnapshot(bandId = "stand-cohorts", seed = 0x51a7d) {
  const band = DENSITY_BANDS[bandId];
  if (!band) throw new RangeError(`Unknown density band: ${bandId}`);
  const random = createRandom(seed ^ hashString(bandId));
  const individuals = [];
  const cohorts = [];
  const canopyPatches = [];

  individuals.push({
    id: "tree-founder",
    kind: "tree",
    speciesId: "acer-saccharum",
    relationship: "managed",
    state: "living",
    stage: "mature",
    x: 57,
    y: 48,
    height: 12.5,
    crownRadius: 4.8,
    vitality: 0.93,
    foliage: 0.96,
    featured: true,
  });

  for (let index = 1; index < band.individuals; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 48;
    const ambient = index % 4 === 0;
    const snag = index % 47 === 0;
    const deadwood = !snag && index % 59 === 0;
    const suppressed = !ambient && !snag && !deadwood && index % 13 === 0;
    const released = suppressed && index % 26 === 0;
    individuals.push({
      id: `tree-${String(index).padStart(4, "0")}`,
      kind: deadwood ? "deadwood" : snag ? "snag" : "tree",
      speciesId: ambient ? null : "acer-saccharum",
      relationship: ambient ? "ambient" : "managed",
      state: deadwood ? "down" : snag ? "dead" : "living",
      stage: suppressed ? "recruit" : index % 5 === 0 ? "sapling" : "mature",
      x: clamp(57 + Math.cos(angle) * radius + (random() - 0.5) * 3, 4, 116),
      y: clamp(48 + Math.sin(angle) * radius * 0.72 + (random() - 0.5) * 3, 4, 88),
      height: suppressed ? 2.2 : 5 + random() * 8,
      crownRadius: suppressed ? 0.8 : 1.6 + random() * 3.2,
      vitality: snag || deadwood ? 0 : clamp(0.48 + random() * 0.52, 0, 1),
      foliage: snag || deadwood ? 0 : suppressed ? 0.38 : clamp(0.56 + random() * 0.44, 0, 1),
      suppressed,
      released,
    });
  }

  for (let index = 0; index < band.cohorts; index += 1) {
    const ambient = index % 5 === 0;
    cohorts.push({
      id: `cohort-${String(index).padStart(4, "0")}`,
      kind: "cohort",
      speciesId: ambient ? null : "acer-saccharum",
      relationship: ambient ? "ambient" : "managed",
      state: index % 71 === 0 ? "mortality" : "living",
      x: 4 + random() * 112,
      y: 5 + random() * 82,
      radiusX: 1.3 + random() * 3.8,
      radiusY: 0.9 + random() * 2.6,
      vitality: clamp(0.42 + random() * 0.58, 0, 1),
      canopyLight: random(),
      gap: index % 97 === 0,
    });
  }

  for (let index = 0; index < band.canopyPatches; index += 1) {
    canopyPatches.push({
      id: `patch-${String(index).padStart(4, "0")}`,
      kind: "canopy-patch",
      speciesId: index % 6 === 0 ? null : "acer-saccharum",
      relationship: index % 6 === 0 ? "ambient" : "managed",
      x: 2 + random() * 116,
      y: 3 + random() * 86,
      radiusX: 2.6 + random() * 8.5,
      radiusY: 1.5 + random() * 5.2,
      cover: 0.34 + random() * 0.66,
      mortality: index % 83 === 0 ? 0.7 : 0,
      gap: index % 109 === 0,
    });
  }

  const snapshot = {
    schema: "stand-presentation-snapshot@1",
    fixtureId: ONEIDA_FIXTURE.id,
    revision: 1,
    forestTimeYears: 78.4,
    rp: 42,
    individuals,
    cohorts,
    canopyPatches,
    seeds: [],
    feedback: [],
    events: [
      { id: "event-3", order: 3, forestTimeYears: 78.4, type: "gap-release", tone: "info", message: "A canopy gap released advance regeneration." },
      { id: "event-2", order: 2, forestTimeYears: 77.9, type: "mortality", tone: "warning", message: "A mature crown opened a small interior gap." },
      { id: "event-1", order: 1, forestTimeYears: 77.3, type: "suppression", tone: "info", message: "Suppressed sugar-maple recruits persist below the canopy." },
    ],
    benchmark: { densityBand: band.id, counts: { individuals: band.individuals, cohorts: band.cohorts, canopyPatches: band.canopyPatches } },
  };
  return deepFreeze(snapshot);
}

export function cloneMutableSnapshot(snapshot) {
  return typeof structuredClone === "function"
    ? structuredClone(snapshot)
    : JSON.parse(JSON.stringify(snapshot));
}

function createRandom(seed) {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function mix(a, b, t) { return a + (b - a) * t; }
function smoothstep(t) { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
