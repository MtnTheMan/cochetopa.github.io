// Renderer-owned appearance data. These records are deliberately not ecological
// entities: they have no speciesId, suitability, occupancy, establishment,
// composition, age, health, or managed relationship.
export const AMBIENT_VISUAL_SEED = 0x30a11;

// Structural profiles provide crown/trunk mass. Accepted foliage assets are
// overlaid as species-readable motifs at eligible stand and close scales.
export const SPECIES_ART_FAMILY_TARGETS = deepFreeze([
  family(1, "acer-saccharum", "Sugar maple", "palmate", 104, 38, 42, 0.96, 0.82),
  family(2, "acer-rubrum", "Red maple", "palmate", 91, 34, 43, 0.90, 0.78),
  family(3, "fagus-grandifolia", "American beech", "oval", 77, 29, 49, 1.08, 0.80),
  family(4, "betula-alleghaniensis", "Yellow birch", "fine", 69, 33, 52, 0.86, 0.91),
  family(5, "tilia-americana", "American basswood", "heart", 96, 31, 45, 1.02, 0.86),
  family(6, "prunus-serotina", "Black cherry", "narrow", 82, 31, 39, 0.79, 1.04),
  family(7, "quercus-rubra", "Northern red oak", "lobed", 68, 33, 43, 1.12, 0.78),
  family(8, "tsuga-canadensis", "Eastern hemlock", "hemlock", 103, 25, 32, 0.82, 1.18),
  family(9, "populus-tremuloides", "Quaking aspen", "round", 72, 31, 55, 0.76, 1.12),
  family(10, "populus-grandidentata", "Bigtooth aspen", "round", 68, 33, 49, 0.84, 1.08),
  family(11, "betula-papyrifera", "Paper birch", "fine", 80, 29, 58, 0.73, 1.18),
  family(12, "populus-balsamifera", "Balsam poplar", "narrow", 84, 30, 46, 0.76, 1.22),
  family(13, "pinus-strobus", "Eastern white pine", "pine", 111, 29, 36, 0.83, 1.35),
  family(14, "pinus-resinosa", "Red pine", "pine", 97, 34, 37, 0.72, 1.40),
  family(15, "pinus-banksiana", "Jack pine", "pine-open", 87, 30, 41, 0.69, 1.26),
  family(16, "abies-balsamea", "Balsam fir", "fir", 115, 30, 31, 0.78, 1.32),
  family(17, "picea-glauca", "White spruce", "spruce", 105, 25, 39, 0.73, 1.40),
  family(18, "picea-mariana", "Black spruce", "spruce", 120, 23, 31, 0.65, 1.48),
  family(19, "thuja-occidentalis", "Northern white-cedar", "cedar", 109, 23, 38, 0.63, 1.35),
  family(20, "larix-laricina", "Tamarack", "larch", 79, 37, 48, 0.69, 1.38),
  family(21, "quercus-alba", "White oak", "lobed", 78, 27, 48, 1.18, 0.76),
  family(22, "quercus-macrocarpa", "Bur oak", "lobed", 72, 31, 42, 1.22, 0.72),
  family(23, "carya-ovata", "Shagbark hickory", "compound", 88, 31, 43, 0.90, 1.02),
  family(24, "juglans-nigra", "Black walnut", "compound", 91, 28, 39, 1.00, 0.92),
  family(25, "fraxinus-nigra", "Black ash", "compound", 102, 27, 38, 0.82, 1.08),
  family(26, "fraxinus-americana", "White ash", "compound", 96, 29, 46, 0.88, 1.05),
  family(27, "ulmus-americana", "American elm", "vase", 89, 31, 44, 1.04, 1.02),
  family(28, "populus-deltoides", "Eastern cottonwood", "round", 82, 32, 50, 1.05, 1.00),
  family(29, "acer-saccharinum", "Silver maple", "palmate", 93, 27, 51, 1.08, 0.92),
  family(30, "castanea-dentata", "American chestnut", "oval", 75, 33, 45, 1.00, 0.88),
]);

export function createAmbientVisualLayer({ seed = AMBIENT_VISUAL_SEED, count = 240, localCount = 720, localFocus = null, localRadius = 2.8, extent = { width: 120, height: 92 }, artBindings = [], loadedFamilyIds = [] } = {}) {
  if (!Number.isInteger(count) || count < SPECIES_ART_FAMILY_TARGETS.length) throw new RangeError("Visual layer needs at least one appearance per target family.");
  if (!Number.isInteger(localCount) || localCount < 0) throw new RangeError("Local appearance count must be a nonnegative integer.");
  const acceptedFamilyIds = [...new Set(artBindings.map((binding) => binding.familyId))].filter((id) => getArtFamily(id));
  const loadedAcceptedFamilyIds = [...new Set(loadedFamilyIds)].filter((id) => acceptedFamilyIds.includes(id));
  const random = createRandom(seed);
  const appearances = [];
  for (let index = 0; index < count; index += 1) {
    const familyIndex = index % SPECIES_ART_FAMILY_TARGETS.length;
    const family = SPECIES_ART_FAMILY_TARGETS[familyIndex];
    appearances.push({
      id: `visual-${String(index).padStart(4, "0")}`,
      layer: "synthetic-visual-only",
      scope: "county-context",
      targetArtFamilyId: family.id,
      x: 3 + random() * (extent.width - 6),
      y: 4 + random() * (extent.height - 8),
      crownScale: 0.72 + random() * 0.68,
      rotation: (random() - 0.5) * 0.42,
      glaze: 0.58 + random() * 0.34,
    });
  }
  if (localFocus && Number.isFinite(localFocus.x) && Number.isFinite(localFocus.y)) {
    for (let index = 0; index < localCount; index += 1) {
      const family = SPECIES_ART_FAMILY_TARGETS[index % SPECIES_ART_FAMILY_TARGETS.length];
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * localRadius;
      appearances.push({
        id: `local-visual-${String(index).padStart(4, "0")}`,
        layer: "synthetic-visual-only",
        scope: "local-stand-context",
        targetArtFamilyId: family.id,
        x: clamp(localFocus.x + Math.cos(angle) * radius, 0.01, extent.width - 0.01),
        y: clamp(localFocus.y + Math.sin(angle) * radius, 0.01, extent.height - 0.01),
        crownScale: 0.72 + random() * 0.68,
        rotation: (random() - 0.5) * 0.42,
        glaze: 0.58 + random() * 0.34,
      });
    }
  }
  const layer = {
    schema: "stand-synthetic-ambient-visual-layer@2",
    seed: seed >>> 0,
    disposition: acceptedFamilyIds.length === 30 ? "structural_tree_profiles_with_accepted_botanical_motifs_presentation_only" : "structural_tree_profiles_with_incomplete_identity_references",
    assetBindingStatus: acceptedFamilyIds.length === 30 ? "botanical_identity_bound_as_crown_motifs_not_stretched_whole_tree" : "incomplete_or_unbound",
    acceptedArtAssetCoverage: acceptedFamilyIds.length,
    loadedRuntimeAssetCoverage: loadedAcceptedFamilyIds.length,
    acceptedFamilyIds,
    sourceDecision: "50c46c9 + 2026-08-21 Mission Control clarification",
    targetFamilyCount: SPECIES_ART_FAMILY_TARGETS.length,
    appearances,
    replayDigest: digestAppearances(appearances),
  };
  return deepFreeze(layer);
}

export function getArtFamily(id) {
  return SPECIES_ART_FAMILY_TARGETS.find((candidate) => candidate.id === id) || null;
}

function family(rosterNumber, id, label, form, hue, saturation, lightness, width, height) {
  return { rosterNumber, id, label, form, color: `hsl(${hue} ${saturation}% ${lightness}%)`, width, height, disposition: "interim_structural_tree_profile_botanical_identity_reference_only" };
}

function digestAppearances(appearances) {
  let hash = 2166136261;
  for (const item of appearances) {
    const value = `${item.id}|${item.targetArtFamilyId}|${item.x.toFixed(5)}|${item.y.toFixed(5)}|${item.crownScale.toFixed(5)}|${item.rotation.toFixed(5)}`;
    for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
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

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
