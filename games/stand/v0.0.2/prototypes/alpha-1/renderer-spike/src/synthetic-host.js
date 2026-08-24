import { cloneMutableSnapshot, createDensitySnapshot } from "./fixture.js";

export function createSyntheticHost({ densityBand = "stand-cohorts", seed = 0x51a7d, now = () => performance.now() } = {}) {
  let snapshot = cloneMutableSnapshot(createDensitySnapshot(densityBand, seed));
  let nextSeed = 1;
  let nextFeedback = 1;

  function getSnapshot(presentationTimeMs = now()) {
    snapshot.seeds = snapshot.seeds.filter((seedItem) => presentationTimeMs - seedItem.presentationBornAtMs < 1600);
    snapshot.feedback = snapshot.feedback.filter((cue) => presentationTimeMs - cue.presentationBornAtMs < 1000);
    return snapshot;
  }

  function dispatch(command) {
    if (!command || typeof command !== "object") return reject("invalid-command");
    if (command.type === "nurture") {
      const tree = snapshot.individuals.find((entity) => entity.id === command.targetId);
      if (!tree || tree.kind !== "tree" || tree.state !== "living" || tree.relationship !== "managed") return reject("ineligible-target");
      snapshot.feedback.push({ id: `feedback-${nextFeedback++}`, type: "nurture", x: tree.x, y: tree.y, targetId: tree.id, presentationBornAtMs: command.presentationTimeMs });
      snapshot.revision += 1;
      return { accepted: true, commandId: command.id, targetId: tree.id, rpSpent: 0, rpAwarded: 0, seedCreated: false };
    }
    if (command.type === "seed-attempt") {
      const source = snapshot.individuals.find((entity) => entity.id === command.sourceId);
      if (!source || source.state !== "living" || source.relationship !== "managed") return reject("no-living-source");
      if (snapshot.rp < 1) return reject("insufficient-rp");
      const direction = normalize(command.directionX, command.directionY);
      if (!direction) return reject("direction-undetermined");
      snapshot.rp -= 1;
      const ordinal = nextSeed++;
      const distance = 5 + (ordinal % 4) * 1.2;
      snapshot.seeds.push({
        id: `seed-${String(ordinal).padStart(4, "0")}`,
        speciesId: "acer-saccharum",
        sourceId: source.id,
        sourceX: source.x,
        sourceY: source.y,
        targetX: clamp(source.x + direction.x * distance, 0, 120),
        targetY: clamp(source.y + direction.y * distance, 0, 92),
        presentationBornAtMs: command.presentationTimeMs,
      });
      snapshot.revision += 1;
      return { accepted: true, commandId: command.id, seedId: snapshot.seeds.at(-1).id, rpSpent: 1, rpAwarded: 0 };
    }
    return reject("unsupported-command");
  }

  function reset(nextBand = densityBand) {
    snapshot = cloneMutableSnapshot(createDensitySnapshot(nextBand, seed));
    nextSeed = 1; nextFeedback = 1;
  }

  return Object.freeze({ getSnapshot, dispatch, reset });

  function reject(reason) { return { accepted: false, reason, rpSpent: 0, rpAwarded: 0, seedCreated: false }; }
}

function normalize(x, y) { const length = Math.hypot(Number(x), Number(y)); return Number.isFinite(length) && length > 1e-6 ? { x: x / length, y: y / length } : null; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
