const DEFAULT_WIDTH = 72;
const DEFAULT_HEIGHT = 54;
const DEFAULT_SEED = 20260803;
const UINT32_RANGE = 0x100000000;
const OUTPUT_PRECISION = 1_000_000;

const REGION = Object.freeze({
  name: "Ingham County",
  state: "Michigan",
  country: "United States",
  inspirationOnly: true,
});
const SYNTHETIC_WARNING =
  "Ingham County-inspired synthetic prototype surface — not the county boundary or real county climate, terrain, land-cover, species-occurrence, or MaxEnt data; not a validated habitat model.";
const STARTING_GUIDANCE =
  "Begin on a mesic, well-drained site; marginal ground is possible but establishment will be less reliable.";

/**
 * Prototype species metadata. The warning is deliberately part of the public
 * record so the selection interface can keep the synthetic surface visible.
 */
export const SPECIES = Object.freeze({
  "acer-saccharum": Object.freeze({
    id: "acer-saccharum",
    commonName: "Sugar maple",
    scientificName: "Acer saccharum",
    seedModality: "Wind-dispersed samara",
    guidance: STARTING_GUIDANCE,
    startingGuidance: STARTING_GUIDANCE,
    syntheticWarning: SYNTHETIC_WARNING,
  }),
});

/**
 * Build a deterministic, synthetic landscape for the alpha prototype.
 *
 * Cells are stored in row-major order (`y * width + x`). Every returned value
 * is a JSON-safe number in [0, 1], and the returned object contains no runtime
 * caches or class instances.
 */
export function createSyntheticWorld(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("World options must be an object.");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const seed = options.seed ?? DEFAULT_SEED;

  assertPositiveInteger(width, "width");
  assertPositiveInteger(height, "height");
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("seed must be a safe integer.");
  }

  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount)) {
    throw new RangeError("World dimensions are too large.");
  }

  const seedBits = integerSeedHash(seed);
  const layout = createLayout(seedBits);
  const cells = new Array(cellCount);

  for (let y = 0; y < height; y += 1) {
    const sourceV = normalizedCoordinate(y, height);

    for (let x = 0; x < width; x += 1) {
      const sourceU = normalizedCoordinate(x, width);
      const u = layout.mirrorX ? 1 - sourceU : sourceU;
      const v = layout.mirrorY ? 1 - sourceV : sourceV;

      const mesicRegion = ellipticalBump(
        u,
        v,
        layout.mesicX,
        layout.mesicY,
        0.35,
        0.43,
      );
      const dryRegion = ellipticalBump(
        u,
        v,
        layout.dryX,
        layout.dryY,
        0.24,
        0.38,
      );
      const wetPocket = ellipticalBump(
        u,
        v,
        layout.wetX,
        layout.wetY,
        0.2,
        0.24,
      );

      const terrainNoise = centered(fbm(u, v, seedBits, 11));
      const moistureNoise = centered(fbm(u, v, seedBits, 23));
      const soilNoise = centered(fbm(u, v, seedBits, 37));
      const lightNoise = centered(fbm(u, v, seedBits, 53));
      const habitatNoise = centered(fbm(u, v, seedBits, 71));
      const ambientNoise = centered(fbm(u, v, seedBits, 89));

      // A broad upland rises toward one side of the world, while the mesic
      // shoulder and wet pocket lower it. Noise is deliberately low-frequency.
      const elevation = unit(
        0.2 +
          0.42 * u +
          0.17 * dryRegion -
          0.11 * mesicRegion -
          0.1 * wetPocket +
          0.16 * terrainNoise,
      );

      const moisture = unit(
        0.58 -
          0.24 * elevation +
          0.2 * mesicRegion -
          0.31 * dryRegion +
          0.27 * wetPocket +
          0.13 * moistureNoise,
      );

      const light = unit(
        0.42 +
          0.29 * elevation +
          0.19 * dryRegion -
          0.12 * mesicRegion -
          0.08 * wetPocket +
          0.1 * lightNoise,
      );

      const soil = unit(
        0.31 +
          0.48 * mesicRegion -
          0.35 * dryRegion +
          0.12 * wetPocket +
          0.12 * soilNoise,
      );

      // Suitability is a transparent prototype score, not a probability of
      // occurrence. Broad region structure guarantees readable habitat bands;
      // environmental fit keeps the score tied to the generated site fields.
      const environmentalFit =
        0.34 * preference(moisture, 0.64, 0.52) +
        0.32 * smooth01((soil - 0.12) / 0.75) +
        0.19 * preference(light, 0.46, 0.58) +
        0.15 * preference(elevation, 0.44, 0.64);
      const regionalFit =
        0.3 +
        0.63 * mesicRegion -
        0.94 * dryRegion -
        0.2 * wetPocket +
        0.1 * habitatNoise;
      const suitability = unit(0.57 * regionalFit + 0.43 * environmentalFit);

      // Ambient density is a separate synthetic background condition. It does
      // not mean sugar-maple occupancy or player-managed influence.
      const ambientDensity = unit(
        0.08 +
          0.4 * moisture +
          0.29 * soil -
          0.16 * light +
          0.1 * ambientNoise,
      );

      cells[y * width + x] = {
        x,
        y,
        elevation,
        moisture,
        light,
        soil,
        suitability,
        ambientDensity,
      };
    }
  }

  return {
    version: 1,
    synthetic: true,
    region: { ...REGION },
    width,
    height,
    seed,
    cells,
  };
}

/**
 * Return the cell containing a continuous grid coordinate, or null when the
 * world/coordinate is invalid or outside [0, width) × [0, height).
 */
export function getCell(world, x, y) {
  if (
    !world ||
    !Number.isInteger(world.width) ||
    !Number.isInteger(world.height) ||
    !Array.isArray(world.cells) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= world.width ||
    y >= world.height
  ) {
    return null;
  }

  const cell = world.cells[Math.floor(y) * world.width + Math.floor(x)];
  return cell && typeof cell === "object" ? cell : null;
}

/**
 * Safely sample the controlled species' suitability. Unsupported species and
 * out-of-bounds coordinates are nonviable and return 0 rather than NaN.
 */
export function suitabilityAt(
  world,
  x,
  y,
  speciesId = "acer-saccharum",
) {
  if (!Object.prototype.hasOwnProperty.call(SPECIES, speciesId)) {
    return 0;
  }

  const cell = getCell(world, x, y);
  return cell && Number.isFinite(cell.suitability) ? unit(cell.suitability) : 0;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function normalizedCoordinate(index, size) {
  return size === 1 ? 0.5 : index / (size - 1);
}

function createLayout(seedBits) {
  return {
    mirrorX: seededUnit(seedBits, 1) < 0.5,
    mirrorY: seededUnit(seedBits, 2) < 0.5,
    mesicX: 0.29 + 0.09 * seededUnit(seedBits, 3),
    mesicY: 0.31 + 0.38 * seededUnit(seedBits, 4),
    dryX: 0.72 + 0.09 * seededUnit(seedBits, 5),
    dryY: 0.25 + 0.5 * seededUnit(seedBits, 6),
    wetX: 0.45 + 0.12 * seededUnit(seedBits, 7),
    wetY: 0.12 + 0.16 * seededUnit(seedBits, 8),
  };
}

function integerSeedHash(seed) {
  // Hash the full decimal representation so negative and >32-bit safe integer
  // seeds do not silently alias through a bitwise coercion.
  const text = String(seed);
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }

  return mix32(hash);
}

function seededUnit(seedBits, stream) {
  return mix32(seedBits ^ Math.imul(stream, 0x9e3779b1)) / UINT32_RANGE;
}

function fbm(u, v, seedBits, channel) {
  const offsetX = 1.5 * seededUnit(seedBits, channel + 101);
  const offsetY = 1.5 * seededUnit(seedBits, channel + 211);
  let frequency = 1.35;
  let amplitude = 0.56;
  let total = 0;
  let weight = 0;

  for (let octave = 0; octave < 3; octave += 1) {
    total +=
      amplitude *
      valueNoise(
        (u + offsetX) * frequency,
        (v + offsetY) * frequency,
        seedBits,
        channel + octave * 977,
      );
    weight += amplitude;
    frequency *= 2;
    amplitude *= 0.52;
  }

  return total / weight;
}

function valueNoise(x, y, seedBits, channel) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth01(x - x0);
  const ty = smooth01(y - y0);
  const a = coordinateUnit(x0, y0, seedBits, channel);
  const b = coordinateUnit(x0 + 1, y0, seedBits, channel);
  const c = coordinateUnit(x0, y0 + 1, seedBits, channel);
  const d = coordinateUnit(x0 + 1, y0 + 1, seedBits, channel);

  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function coordinateUnit(x, y, seedBits, channel) {
  let hash = seedBits ^ Math.imul(channel, 0x85ebca6b);
  hash ^= Math.imul(x, 0x27d4eb2d);
  hash ^= Math.imul(y, 0x165667b1);
  return mix32(hash) / UINT32_RANGE;
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function ellipticalBump(u, v, centerX, centerY, radiusX, radiusY) {
  const dx = (u - centerX) / radiusX;
  const dy = (v - centerY) / radiusY;
  return smooth01(1 - dx * dx - dy * dy);
}

function preference(value, optimum, tolerance) {
  return smooth01(1 - Math.abs(value - optimum) / tolerance);
}

function centered(value) {
  return value * 2 - 1;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function smooth01(value) {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function unit(value) {
  return Math.round(clamp01(value) * OUTPUT_PRECISION) / OUTPUT_PRECISION;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
