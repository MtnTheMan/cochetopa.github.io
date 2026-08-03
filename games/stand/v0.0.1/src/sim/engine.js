import { nextRandom, normalizeSeed } from "./prng.js";

export const FOUNDER_MIN_SUITABILITY = 0.24;
const CONTROLLED_SPECIES_ID = "acer-saccharum";

export const SIMULATION_RULES = Object.freeze({
  eventLimit: 200,
  maxSeeds: 256,
  maxTrees: 256,
  maxGestureSeeds: 24,
  maxTimeSpeed: 64,
  maxStepYears: 10_000,
  seedCostRp: 20,
  founderLandingYears: 0.05,
  founderEstablishmentYears: 0.12,
  seedLandingYears: 0.06,
  seedGerminationYears: 0.18,
  failedSeedVisibleYears: 0.45,
  founderNurtureDevelopment: 1.2,
});

const STAGES = Object.freeze([
  { name: "seedling", development: 0, rp: 0 },
  { name: "sapling", development: 1, rp: 8 },
  { name: "young", development: 3, rp: 12 },
  { name: "mature", development: 8, rp: 20 },
  { name: "senescent", development: 55, rp: 0 },
]);

const ESTABLISHMENT_RP = 28;
const FOUNDER_SAPLING_RP = 20;
const FOUNDER_PRE_NURTURE_DEVELOPMENT_CAP = 0.98;
const MAX_RP = 1_000_000_000;
const EPSILON = 1e-9;

export function createSimulation(options = {}) {
  const seed = options.seed;
  const rngState = normalizeSeed(seed);
  const speed = normalizeSpeed(options.speed ?? 1);
  const initialRp = options.initialRp ?? options.rp ?? 0;

  if (!isFiniteNumber(initialRp) || initialRp < 0) {
    throw new TypeError("Initial RP must be a finite, nonnegative number.");
  }

  const speciesId = options.speciesId ?? CONTROLLED_SPECIES_ID;
  if (speciesId !== CONTROLLED_SPECIES_ID) {
    throw new RangeError(`Stand v0.0.1 Alpha supports only ${CONTROLLED_SPECIES_ID}.`);
  }

  return {
    version: 1,
    seed,
    rngState,
    speciesId,
    timeYears: 0,
    speed,
    rp: roundResource(Math.min(initialRp, MAX_RP)),
    founderId: null,
    founderNurture: 0,
    nextEntityId: 1,
    trees: [],
    seeds: [],
    events: [],
    stats: { established: 0, failed: 0, alive: 0 },
  };
}

export function placeFounder(state, world, x, y) {
  requireSimulationState(state);
  requireWorld(world);

  if (state.founderId !== null) {
    return rejected("founder-already-placed", { x, y });
  }

  if (!isInsideWorld(world, x, y)) {
    return rejected("outside-world", { x, y, suitability: 0 });
  }

  const site = siteAt(world, x, y, state.speciesId);
  if (site.suitability < FOUNDER_MIN_SUITABILITY) {
    return rejected("low-suitability", {
      x,
      y,
      suitability: site.suitability,
      minimumSuitability: FOUNDER_MIN_SUITABILITY,
    });
  }

  if (state.seeds.length >= SIMULATION_RULES.maxSeeds) {
    return rejected("seed-capacity", { x, y, suitability: site.suitability });
  }
  if (!hasEntityIdCapacity(state, 1)) {
    return rejected("identifier-capacity", { x, y, suitability: site.suitability });
  }

  const id = allocateEntityId(state);
  const traits = drawTreeTraits(state, site.suitability);
  const visualAngle = randomFloat(state) * Math.PI * 2;
  const seed = {
    id,
    x,
    y,
    age: 0,
    state: "falling",
    managed: true,
    sourceTreeId: null,
    visualAngle,
    suitability: site.suitability,
    establishmentProbability: 1,
    outcomeRoll: 0,
    willEstablish: true,
    resolutionAge: SIMULATION_RULES.founderEstablishmentYears,
    failureReason: null,
    founder: true,
    releaseOffset: 0,
    traits,
  };

  state.founderId = id;
  state.seeds.push(seed);
  const event = makeEvent(
    "founder-samara-released",
    state.timeYears,
    id,
    x,
    y,
    "founding-placement",
  );
  appendEvents(state, [event]);

  return {
    accepted: true,
    reason: null,
    founderId: id,
    seedId: id,
    x,
    y,
    suitability: site.suitability,
    minimumSuitability: FOUNDER_MIN_SUITABILITY,
    event: clonePlain(event),
  };
}

export function nurtureFounder(state, amount = 1) {
  requireSimulationState(state);

  if (!isFiniteNumber(amount) || amount <= 0) {
    return rejected("invalid-nurture-amount", {
      amount,
      total: state.founderNurture,
    });
  }

  const founder = state.trees.find(
    (tree) => tree.id === state.founderId && tree.founder,
  );
  if (!founder) {
    const founderSeed = state.seeds.some((seed) => seed.id === state.founderId);
    return rejected(founderSeed ? "founder-still-landing" : "founder-missing", {
      amount,
      total: state.founderNurture,
    });
  }
  if (!founder.alive) {
    return rejected("founder-not-alive", {
      amount,
      total: state.founderNurture,
    });
  }

  const previous = state.founderNurture;
  const next = clamp(previous + amount, 0, 1);
  const applied = next - previous;
  if (applied <= EPSILON) {
    return rejected("founder-fully-nurtured", { amount, applied: 0, total: previous });
  }

  // Nurture visibly advances the tree, but lifecycle RP is awarded only when
  // stepSimulation processes the resulting qualifying stage transition.
  state.founderNurture = next;
  const pendingNurture = Math.max(0, next - founder.nurtureApplied);
  const previewDevelopment =
    founder.development +
    pendingNurture * SIMULATION_RULES.founderNurtureDevelopment;
  founder.size = Math.max(founder.size, sizeForDevelopment(previewDevelopment));
  founder.vitality = clamp(founder.vitality + applied * 0.08, 0, 1);

  const events = [];
  if (previous < 1 - EPSILON && next >= 1 - EPSILON) {
    events.push(
      makeEvent(
        "founder-nurtured",
        state.timeYears,
        founder.id,
        founder.x,
        founder.y,
        "sunlight-and-water",
      ),
    );
    appendEvents(state, events);
  }

  return {
    accepted: true,
    reason: null,
    amount,
    applied,
    total: next,
    rpEarned: 0,
    events: events.map(clonePlain),
  };
}

export function disperseFromGesture(state, world, gesture = {}) {
  requireSimulationState(state);
  requireWorld(world);

  if (!gesture || typeof gesture !== "object" || Array.isArray(gesture)) {
    return rejected("invalid-gesture");
  }

  const source = selectDispersalSource(state, gesture);
  if (!source) return rejected("no-reproductive-source");

  const requested = requestedSeedCount(gesture);
  if (requested < 1) return rejected("invalid-seed-count", { requested });

  const affordable = Math.floor((state.rp + EPSILON) / SIMULATION_RULES.seedCostRp);
  if (affordable < 1) {
    return rejected("insufficient-rp", {
      requested,
      affordable: 0,
      costPerSeed: SIMULATION_RULES.seedCostRp,
      remainingRp: state.rp,
    });
  }

  const capacity = Math.min(
    SIMULATION_RULES.maxSeeds - state.seeds.length,
    Number.MAX_SAFE_INTEGER - state.nextEntityId,
  );
  if (capacity < 1) {
    return rejected("seed-capacity", {
      requested,
      affordable,
      costPerSeed: SIMULATION_RULES.seedCostRp,
      remainingRp: state.rp,
    });
  }

  const released = Math.min(
    requested,
    affordable,
    capacity,
    SIMULATION_RULES.maxGestureSeeds,
  );
  const vector = gestureVector(gesture, source);
  const direction = normalizedDirection(state, vector.dx, vector.dy);
  const dragDistance = clamp(
    explicitFinite(gesture.distance, Math.hypot(vector.dx, vector.dy)),
    0,
    24,
  );
  const emittedEvents = [];
  const seedIds = [];

  for (let index = 0; index < released; index += 1) {
    const seed = createDispersedSeed(
      state,
      world,
      source,
      direction,
      dragDistance,
      index,
    );
    state.seeds.push(seed);
    seedIds.push(seed.id);
    emittedEvents.push(
      makeEvent(
        "samara-dispersed",
        state.timeYears,
        seed.id,
        seed.x,
        seed.y,
        "player-gesture",
      ),
    );
  }

  const spent = released * SIMULATION_RULES.seedCostRp;
  state.rp = roundResource(Math.max(0, state.rp - spent));
  appendEvents(state, emittedEvents);

  return {
    accepted: true,
    reason: null,
    requested,
    released,
    count: released,
    spent,
    costPerSeed: SIMULATION_RULES.seedCostRp,
    remainingRp: state.rp,
    sourceTreeId: source.id,
    seedIds,
    exhausted: released < requested,
    events: emittedEvents.map(clonePlain),
  };
}

export function stepSimulation(state, world, deltaYears) {
  requireSimulationState(state);
  requireWorld(world);

  if (!isFiniteNumber(deltaYears) || deltaYears < 0) {
    throw new TypeError("deltaYears must be a finite, nonnegative number.");
  }
  if (deltaYears > SIMULATION_RULES.maxStepYears) {
    throw new RangeError(
      `deltaYears cannot exceed ${SIMULATION_RULES.maxStepYears} in one step.`,
    );
  }

  const startTime = state.timeYears;
  const endTime = roundTime(startTime + deltaYears);
  if (!Number.isFinite(endTime) || endTime > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Simulation time would exceed the supported range.");
  }
  // Integration owns conversion from frame time and the selected speed into
  // ecological years. The engine stores speed for UI/save state but does not
  // apply it a second time here.
  const effectiveDelta = Math.max(0, endTime - startTime);

  const pendingEvents = [];
  const summary = {
    requestedDeltaYears: deltaYears,
    deltaYears: effectiveDelta,
    timeYears: endTime,
    rpEarned: 0,
    established: 0,
    failed: 0,
    died: 0,
    events: [],
  };

  // Existing trees advance first. Seed outcomes were fixed when each seed was
  // created, so no step-size-dependent random draws occur here.
  for (const tree of state.trees) {
    advanceTree(
      state,
      world,
      tree,
      effectiveDelta,
      startTime,
      pendingEvents,
      summary,
    );
  }

  const remainingSeeds = [];
  const establishedTrees = [];
  for (const seed of state.seeds) {
    const outcome = advanceSeed(
      state,
      world,
      seed,
      effectiveDelta,
      startTime,
      pendingEvents,
      summary,
    );
    if (outcome.keepSeed) remainingSeeds.push(seed);
    if (outcome.tree) establishedTrees.push(outcome.tree);
  }

  state.seeds = remainingSeeds;
  for (const tree of establishedTrees) {
    if (state.trees.length >= SIMULATION_RULES.maxTrees) break;
    state.trees.push(tree);
  }

  pendingEvents.sort((left, right) => {
    if (left.event.timeYears !== right.event.timeYears) {
      return left.event.timeYears - right.event.timeYears;
    }
    return left.order - right.order;
  });
  const orderedEvents = pendingEvents.map((entry) => entry.event);

  state.timeYears = endTime;
  state.stats.alive = state.trees.reduce(
    (count, tree) => count + (tree.alive ? 1 : 0),
    0,
  );
  state.rp = roundResource(clamp(state.rp, 0, MAX_RP));
  appendEvents(state, orderedEvents);
  summary.events = orderedEvents.map(clonePlain);

  requireSimulationState(state);
  return summary;
}

export function setTimeSpeed(state, speed) {
  requireSimulationState(state);
  const normalized = normalizeSpeed(speed);
  state.speed = normalized;
  return normalized;
}

export function snapshotSimulation(state) {
  requireSimulationState(state);
  return clonePlain(state);
}

export function restoreSimulation(snapshot) {
  let parsed = snapshot;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new TypeError(`Invalid simulation snapshot JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Simulation snapshot must be a plain object or JSON string.");
  }

  const restored = clonePlain(parsed);
  requireSimulationState(restored);
  return restored;
}

function advanceSeed(
  state,
  world,
  seed,
  deltaYears,
  startTime,
  pendingEvents,
  summary,
) {
  const oldAge = seed.age;
  const newAge = roundTime(oldAge + deltaYears);
  const landingAge = seed.founder
    ? SIMULATION_RULES.founderLandingYears
    : SIMULATION_RULES.seedLandingYears;

  if (crossed(oldAge, newAge, landingAge)) {
    queueEvent(
      pendingEvents,
      "seed-landed",
      crossingTime(startTime, oldAge, landingAge),
      seed,
      seed.founder ? "founding-samara" : "sugar-maple-samara",
    );
  }

  if (!seed.founder && crossed(oldAge, newAge, SIMULATION_RULES.seedGerminationYears)) {
    queueEvent(
      pendingEvents,
      "seed-germinating",
      crossingTime(startTime, oldAge, SIMULATION_RULES.seedGerminationYears),
      seed,
      seed.suitability < 0.4 ? "slow-marginal-germination" : "germination",
    );
  }

  if (seed.state === "failed") {
    seed.age = newAge;
    const clearAge = seed.resolutionAge + SIMULATION_RULES.failedSeedVisibleYears;
    return { keepSeed: newAge < clearAge - EPSILON, tree: null };
  }

  if (newAge + EPSILON < seed.resolutionAge) {
    seed.age = newAge;
    if (newAge + EPSILON >= SIMULATION_RULES.seedGerminationYears && !seed.founder) {
      seed.state = "germinating";
    } else if (newAge + EPSILON >= landingAge) {
      seed.state = "landed";
    }
    return { keepSeed: true, tree: null };
  }

  const resolutionTime = crossingTime(startTime, oldAge, seed.resolutionAge);
  if (!seed.willEstablish) {
    seed.age = newAge;
    seed.state = "failed";
    state.stats.failed += 1;
    summary.failed += 1;
    queueEvent(
      pendingEvents,
      "seed-failed",
      resolutionTime,
      seed,
      seed.failureReason,
    );
    const clearAge = seed.resolutionAge + SIMULATION_RULES.failedSeedVisibleYears;
    return { keepSeed: newAge < clearAge - EPSILON, tree: null };
  }

  if (state.trees.length + summary.established >= SIMULATION_RULES.maxTrees) {
    seed.age = newAge;
    seed.state = "failed";
    state.stats.failed += 1;
    summary.failed += 1;
    queueEvent(
      pendingEvents,
      "seed-failed",
      resolutionTime,
      seed,
      "growing-space-full",
    );
    return { keepSeed: false, tree: null };
  }

  const tree = treeFromSeed(seed);
  state.stats.established += 1;
  summary.established += 1;
  queueEvent(
    pendingEvents,
    "tree-established",
    resolutionTime,
    tree,
    seed.founder ? "founding-tree" : "successful-regeneration",
  );

  if (!seed.founder) {
    awardRp(
      state,
      ESTABLISHMENT_RP,
      resolutionTime,
      tree,
      "established-recruit",
      pendingEvents,
      summary,
    );
  }

  const overshoot = Math.max(0, newAge - seed.resolutionAge);
  if (overshoot > EPSILON || (tree.founder && state.founderNurture > 0)) {
    advanceTree(
      state,
      world,
      tree,
      overshoot,
      resolutionTime,
      pendingEvents,
      summary,
    );
  }

  return { keepSeed: false, tree };
}

function advanceTree(
  state,
  world,
  tree,
  deltaYears,
  startTime,
  pendingEvents,
  summary,
) {
  if (!tree.alive) return;

  const oldAge = tree.age;
  const deathAge = Math.max(oldAge, tree.mortalityAge);
  const aliveDelta = Math.max(0, Math.min(deltaYears, deathAge - oldAge));
  const site = siteAt(world, tree.x, tree.y, state.speciesId);
  const crowding = localCrowding(state.trees, tree);
  const targetVitality = clamp(
    0.32 + site.suitability * 0.68 - site.ambientDensity * 0.1 - crowding * 0.035,
    0.08,
    1,
  );
  const vitalityBlend = 1 - Math.exp(-aliveDelta * 0.32);
  tree.vitality = clamp(
    tree.vitality + (targetVitality - tree.vitality) * vitalityBlend,
    0,
    1,
  );
  tree.siteSuitability = site.suitability;

  const oldDevelopment = tree.development;
  const nurtureDelta = tree.founder
    ? Math.max(0, state.founderNurture - tree.nurtureApplied)
    : 0;
  const nurtureDevelopment =
    nurtureDelta * SIMULATION_RULES.founderNurtureDevelopment;
  const growthRate =
    (0.45 + site.suitability * 0.75) *
    tree.growthVariation *
    Math.max(0.62, 1 - crowding * 0.025);
  const ageDevelopment = aliveDelta * growthRate;
  const unconstrainedDevelopment =
    oldDevelopment + nurtureDevelopment + ageDevelopment;
  const newDevelopment = roundContinuous(
    tree.founder && state.founderNurture < 1 - EPSILON
      ? Math.min(
          unconstrainedDevelopment,
          FOUNDER_PRE_NURTURE_DEVELOPMENT_CAP,
        )
      : unconstrainedDevelopment,
  );

  tree.development = newDevelopment;
  tree.nurtureApplied = tree.founder ? state.founderNurture : 0;
  tree.age = roundTime(oldAge + aliveDelta);
  tree.size = Math.max(tree.size, sizeForDevelopment(newDevelopment));

  const currentStageIndex = Math.max(0, stageIndex(tree.stage));
  let resultingStage = tree.stage;
  for (let index = currentStageIndex + 1; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    if (newDevelopment + EPSILON < stage.development) break;

    const transitionTime = developmentCrossingTime({
      startTime,
      oldDevelopment,
      threshold: stage.development,
      nurtureDevelopment,
      ageDevelopment,
      aliveDelta,
    });
    resultingStage = stage.name;
    queueEvent(
      pendingEvents,
      "tree-stage-changed",
      transitionTime,
      tree,
      stage.name,
    );

    const reward = tree.founder && stage.name === "sapling"
      ? FOUNDER_SAPLING_RP
      : stage.rp;
    if (reward > 0) {
      awardRp(
        state,
        reward,
        transitionTime,
        tree,
        `${stage.name}-growth`,
        pendingEvents,
        summary,
      );
    }
  }
  tree.stage = resultingStage;

  if (oldAge + deltaYears + EPSILON >= tree.mortalityAge) {
    const deathTime = startTime + Math.max(0, tree.mortalityAge - oldAge);
    tree.age = tree.mortalityAge;
    tree.alive = false;
    tree.stage = "dead";
    tree.vitality = 0;
    summary.died += 1;
    queueEvent(
      pendingEvents,
      "tree-died",
      deathTime,
      tree,
      "ordinary-mortality",
    );
  }
}

function treeFromSeed(seed) {
  return {
    id: seed.id,
    x: seed.x,
    y: seed.y,
    age: 0,
    size: sizeForDevelopment(0),
    vitality: seed.traits.initialVitality,
    stage: "seedling",
    managed: seed.managed,
    founder: seed.founder,
    alive: true,
    development: 0,
    nurtureApplied: 0,
    growthVariation: seed.traits.growthVariation,
    mortalityAge: seed.traits.mortalityAge,
    siteSuitability: seed.suitability,
  };
}

function createDispersedSeed(state, world, source, direction, dragDistance, index) {
  const angleJitter = (randomFloat(state) - 0.5) * 1.35;
  const travelShape = (randomFloat(state) + randomFloat(state)) * 0.5;
  const crosswind = (randomFloat(state) - 0.5) * 0.9;
  const kernelDistance = clamp(1.3 + Math.sqrt(dragDistance + 1) * 1.55, 1.3, 9);
  const travel = kernelDistance * (0.42 + travelShape * 1.05);
  const baseAngle = Math.atan2(direction.y, direction.x) + angleJitter;
  const perpendicularX = -Math.sin(baseAngle);
  const perpendicularY = Math.cos(baseAngle);
  const x = clamp(
    source.x + Math.cos(baseAngle) * travel + perpendicularX * crosswind,
    0,
    worldUpperBound(world.width),
  );
  const y = clamp(
    source.y + Math.sin(baseAngle) * travel + perpendicularY * crosswind,
    0,
    worldUpperBound(world.height),
  );
  const site = siteAt(world, x, y, state.speciesId);
  const crowding = localCrowding(state.trees, { id: null, x, y });
  const probability = establishmentProbability(site, crowding);
  const outcomeRoll = randomFloat(state);
  const resolutionAge =
    0.32 + (1 - site.suitability) * 0.38 + randomFloat(state) * 0.16;
  const visualAngle = randomFloat(state) * Math.PI * 2;
  const traits = drawTreeTraits(state, site.suitability);
  const id = allocateEntityId(state);

  return {
    id,
    x,
    y,
    age: 0,
    state: "falling",
    managed: true,
    sourceTreeId: source.id,
    visualAngle,
    suitability: site.suitability,
    establishmentProbability: probability,
    outcomeRoll,
    willEstablish: outcomeRoll < probability,
    resolutionAge,
    failureReason: failureReason(site, crowding),
    founder: false,
    releaseOffset: index * 0.12,
    traits,
  };
}

function establishmentProbability(site, crowding) {
  const habitat = clamp((site.suitability - 0.08) / 0.84, 0, 1);
  const habitatProbability = Math.pow(habitat, 1.12) * 0.9;
  const ambientFactor = 1 - site.ambientDensity * 0.12;
  const crowdingFactor = clamp(1 - crowding * 0.075, 0.18, 1);
  return clamp(habitatProbability * ambientFactor * crowdingFactor, 0, 0.9);
}

function failureReason(site, crowding) {
  if (site.suitability < 0.34) return "marginal-site";
  if (crowding >= 4 || site.ambientDensity > 0.82) return "competition";
  if (site.suitability < 0.58) return "slow-establishment";
  return "establishment-chance";
}

function drawTreeTraits(state, suitability) {
  const initialVitality = clamp(
    0.44 + suitability * 0.5 + (randomFloat(state) - 0.5) * 0.08,
    0.2,
    1,
  );
  const growthVariation = 0.9 + randomFloat(state) * 0.2;
  const mortalityAge = 68 + suitability * 40 + randomFloat(state) * 38;
  return { initialVitality, growthVariation, mortalityAge };
}

function awardRp(
  state,
  amount,
  timeYears,
  entity,
  reason,
  pendingEvents,
  summary,
) {
  const room = Math.max(0, MAX_RP - state.rp);
  const awarded = Math.min(amount, room);
  if (awarded <= 0) return;
  state.rp = roundResource(state.rp + awarded);
  summary.rpEarned = roundResource(summary.rpEarned + awarded);
  queueEvent(pendingEvents, "rp-earned", timeYears, entity, reason);
}

function developmentCrossingTime({
  startTime,
  oldDevelopment,
  threshold,
  nurtureDevelopment,
  ageDevelopment,
  aliveDelta,
}) {
  const needed = Math.max(0, threshold - oldDevelopment);
  if (needed <= nurtureDevelopment + EPSILON) return startTime;
  if (ageDevelopment <= EPSILON || aliveDelta <= EPSILON) return startTime;
  const ageFraction = clamp(
    (needed - nurtureDevelopment) / ageDevelopment,
    0,
    1,
  );
  return startTime + aliveDelta * ageFraction;
}

function queueEvent(pendingEvents, type, timeYears, entity, reason) {
  pendingEvents.push({
    order: pendingEvents.length,
    event: makeEvent(type, timeYears, entity.id, entity.x, entity.y, reason),
  });
}

function makeEvent(type, timeYears, entityId, x, y, reason) {
  return {
    type,
    timeYears: roundTime(timeYears),
    entityId,
    x,
    y,
    reason,
  };
}

function appendEvents(state, events) {
  if (events.length === 0) return;
  state.events.push(...events);
  if (state.events.length > SIMULATION_RULES.eventLimit) {
    state.events.splice(0, state.events.length - SIMULATION_RULES.eventLimit);
  }
}

function selectDispersalSource(state, gesture) {
  const eligible = state.trees.filter(
    (tree) => tree.alive && tree.managed && isSeedSource(tree),
  );
  if (eligible.length === 0) return null;

  const requestedId = gesture.sourceTreeId ?? gesture.sourceId;
  if (requestedId !== undefined && requestedId !== null) {
    return eligible.find((tree) => tree.id === requestedId) ?? null;
  }

  const origin = gestureOrigin(gesture);
  if (origin) {
    return eligible.reduce((closest, tree) => {
      const distance = squaredDistance(tree, origin);
      return !closest || distance < closest.distance
        ? { tree, distance }
        : closest;
    }, null).tree;
  }

  return eligible.find((tree) => tree.id === state.founderId) ?? eligible[0];
}

function isSeedSource(tree) {
  if (tree.founder) return stageIndex(tree.stage) >= stageIndex("sapling");
  return stageIndex(tree.stage) >= stageIndex("young");
}

function requestedSeedCount(gesture) {
  const direct = gesture.count ?? gesture.attempts ?? gesture.seedCount;
  if (direct !== undefined) {
    return Number.isFinite(Number(direct)) ? Math.floor(Number(direct)) : 0;
  }

  const durationMs = gesture.durationMs ?? gesture.holdDurationMs;
  if (isFiniteNumber(durationMs) && durationMs > 0) {
    return 1 + Math.floor(durationMs / 260);
  }
  const durationSeconds = gesture.durationSeconds ?? gesture.holdDuration;
  if (isFiniteNumber(durationSeconds) && durationSeconds > 0) {
    return 1 + Math.floor((durationSeconds * 1000) / 260);
  }
  return 1;
}

function gestureOrigin(gesture) {
  const candidate = gesture.start ?? gesture.from ?? gesture.source;
  if (candidate && isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y)) {
    return { x: candidate.x, y: candidate.y };
  }
  if (isFiniteNumber(gesture.startX) && isFiniteNumber(gesture.startY)) {
    return { x: gesture.startX, y: gesture.startY };
  }
  if (isFiniteNumber(gesture.sourceX) && isFiniteNumber(gesture.sourceY)) {
    return { x: gesture.sourceX, y: gesture.sourceY };
  }
  return null;
}

function gestureVector(gesture, source) {
  const start = gestureOrigin(gesture) ?? { x: source.x, y: source.y };
  const endCandidate = gesture.end ?? gesture.to ?? gesture.target;
  if (
    endCandidate &&
    isFiniteNumber(endCandidate.x) &&
    isFiniteNumber(endCandidate.y)
  ) {
    return { dx: endCandidate.x - start.x, dy: endCandidate.y - start.y };
  }
  if (isFiniteNumber(gesture.endX) && isFiniteNumber(gesture.endY)) {
    return { dx: gesture.endX - start.x, dy: gesture.endY - start.y };
  }
  if (isFiniteNumber(gesture.dx) || isFiniteNumber(gesture.dy)) {
    return {
      dx: explicitFinite(gesture.dx, 0),
      dy: explicitFinite(gesture.dy, 0),
    };
  }
  const direction = gesture.direction;
  if (Array.isArray(direction) && direction.length >= 2) {
    return {
      dx: explicitFinite(direction[0], 0),
      dy: explicitFinite(direction[1], 0),
    };
  }
  if (direction && typeof direction === "object") {
    return {
      dx: explicitFinite(direction.x ?? direction.dx, 0),
      dy: explicitFinite(direction.y ?? direction.dy, 0),
    };
  }
  if (isFiniteNumber(gesture.directionX) || isFiniteNumber(gesture.directionY)) {
    return {
      dx: explicitFinite(gesture.directionX, 0),
      dy: explicitFinite(gesture.directionY, 0),
    };
  }
  if (isFiniteNumber(gesture.x) && isFiniteNumber(gesture.y)) {
    return { dx: gesture.x - source.x, dy: gesture.y - source.y };
  }
  if (isFiniteNumber(gesture.angle)) {
    return { dx: Math.cos(gesture.angle), dy: Math.sin(gesture.angle) };
  }
  return { dx: 0, dy: 0 };
}

function normalizedDirection(state, dx, dy) {
  const magnitude = Math.hypot(dx, dy);
  if (magnitude > EPSILON) return { x: dx / magnitude, y: dy / magnitude };
  const angle = randomFloat(state) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function localCrowding(trees, target) {
  let crowding = 0;
  for (const tree of trees) {
    if (!tree.alive || tree.id === target.id) continue;
    const distanceSquared = squaredDistance(tree, target);
    if (distanceSquared < 0.36) crowding += 2;
    else if (distanceSquared < 1.44) crowding += 1;
  }
  return Math.min(crowding, 10);
}

function siteAt(world, x, y, speciesId) {
  // Match data/world.js getCell semantics so displayed and simulated site
  // values agree throughout the continuous < width / < height domain.
  const cell = cellAt(
    world,
    Math.floor(clamp(x, 0, worldUpperBound(world.width))),
    Math.floor(clamp(y, 0, worldUpperBound(world.height))),
  );
  return {
    suitability: cellSuitability(cell, speciesId),
    ambientDensity: boundedCellValue(cell?.ambientDensity),
  };
}

function cellAt(world, x, y) {
  const indexed = world.cells[y * world.width + x];
  if (indexed && indexed.x === x && indexed.y === y) return indexed;
  return world.cells.find((cell) => cell.x === x && cell.y === y) ?? null;
}

function cellSuitability(cell, speciesId) {
  if (!cell) return 0;
  if (isFiniteNumber(cell.suitability)) return clamp(cell.suitability, 0, 1);
  if (cell.suitability && typeof cell.suitability === "object") {
    return boundedCellValue(cell.suitability[speciesId]);
  }
  return 0;
}

function boundedCellValue(value) {
  return isFiniteNumber(value) ? clamp(value, 0, 1) : 0;
}

function allocateEntityId(state) {
  if (!hasEntityIdCapacity(state, 1)) {
    throw new RangeError("Simulation identifier capacity exhausted.");
  }
  const occupied = new Set([
    ...state.trees.map((tree) => tree.id),
    ...state.seeds.map((seed) => seed.id),
  ]);
  let id;
  do {
    id = `entity-${state.nextEntityId}`;
    state.nextEntityId += 1;
  } while (occupied.has(id));
  return id;
}

function randomFloat(state) {
  const next = nextRandom(state.rngState);
  state.rngState = next.rngState;
  return next.value;
}

function sizeForDevelopment(development) {
  return clamp(0.08 + 1.12 * (1 - Math.exp(-Math.max(0, development) / 11)), 0.08, 1.2);
}

function stageIndex(stage) {
  if (stage === "dead") return STAGES.length;
  return STAGES.findIndex((candidate) => candidate.name === stage);
}

function crossingTime(startTime, oldAge, threshold) {
  return startTime + Math.max(0, threshold - oldAge);
}

function crossed(oldValue, newValue, threshold) {
  return oldValue < threshold - EPSILON && newValue + EPSILON >= threshold;
}

function squaredDistance(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function normalizeSpeed(speed) {
  if (!isFiniteNumber(speed) || speed < 0) {
    throw new TypeError("Simulation speed must be a finite, nonnegative number.");
  }
  return clamp(speed, 0, SIMULATION_RULES.maxTimeSpeed);
}

function requireWorld(world) {
  if (!world || typeof world !== "object") {
    throw new TypeError("world must be a synthetic world object.");
  }
  if (!Number.isInteger(world.width) || world.width < 1) {
    throw new TypeError("world.width must be a positive integer.");
  }
  if (!Number.isInteger(world.height) || world.height < 1) {
    throw new TypeError("world.height must be a positive integer.");
  }
  if (!Array.isArray(world.cells)) {
    throw new TypeError("world.cells must be an array.");
  }
}

function requireSimulationState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Simulation state must be a plain object.");
  }
  if (state.version !== 1) throw new RangeError("Unsupported simulation version.");
  if (!Number.isSafeInteger(state.seed)) {
    throw new TypeError("Simulation state has an invalid seed.");
  }
  if (state.speciesId !== CONTROLLED_SPECIES_ID) {
    throw new RangeError(`Simulation state must use ${CONTROLLED_SPECIES_ID}.`);
  }
  if (!Number.isInteger(state.rngState) || state.rngState < 0 || state.rngState > 0xffffffff) {
    throw new TypeError("Simulation state has an invalid rngState.");
  }
  if (!isFiniteNumber(state.timeYears) || state.timeYears < 0) {
    throw new TypeError("Simulation state has invalid timeYears.");
  }
  if (!isFiniteNumber(state.speed) || state.speed < 0 || state.speed > SIMULATION_RULES.maxTimeSpeed) {
    throw new TypeError("Simulation state has an invalid speed.");
  }
  if (!isFiniteNumber(state.rp) || state.rp < 0 || state.rp > MAX_RP) {
    throw new TypeError("Simulation state has invalid RP.");
  }
  if (
    !isFiniteNumber(state.founderNurture) ||
    state.founderNurture < 0 ||
    state.founderNurture > 1
  ) {
    throw new RangeError("Simulation state has invalid founderNurture.");
  }
  if (!Number.isSafeInteger(state.nextEntityId) || state.nextEntityId < 1) {
    throw new TypeError("Simulation state has an invalid nextEntityId.");
  }
  if (!Array.isArray(state.trees) || !Array.isArray(state.seeds) || !Array.isArray(state.events)) {
    throw new TypeError("Simulation entity and event collections must be arrays.");
  }
  if (state.trees.length > SIMULATION_RULES.maxTrees) {
    throw new RangeError("Simulation tree capacity exceeded.");
  }
  if (state.seeds.length > SIMULATION_RULES.maxSeeds) {
    throw new RangeError("Simulation seed capacity exceeded.");
  }
  if (state.events.length > SIMULATION_RULES.eventLimit) {
    throw new RangeError("Simulation event history exceeds its cap.");
  }
  if (
    !state.stats ||
    !Number.isSafeInteger(state.stats.established) ||
    state.stats.established < 0 ||
    !Number.isSafeInteger(state.stats.failed) ||
    state.stats.failed < 0 ||
    !Number.isSafeInteger(state.stats.alive) ||
    state.stats.alive < 0
  ) {
    throw new TypeError("Simulation stats are invalid.");
  }

  const ids = new Set();
  for (const entity of [...state.trees, ...state.seeds]) {
    if (!entity || (typeof entity.id !== "string" && !Number.isSafeInteger(entity.id))) {
      throw new TypeError("Simulation entity has an invalid identifier.");
    }
    if (ids.has(entity.id)) throw new RangeError("Duplicate simulation entity identifier.");
    ids.add(entity.id);
    if (!isFiniteNumber(entity.x) || !isFiniteNumber(entity.y)) {
      throw new TypeError("Simulation entity coordinates must be finite.");
    }
    if (!isFiniteNumber(entity.age) || entity.age < 0) {
      throw new TypeError("Simulation entity age must be finite and nonnegative.");
    }
  }
  for (const seed of state.seeds) {
    if (!["falling", "landed", "germinating", "failed"].includes(seed.state)) {
      throw new RangeError("Seed has an invalid lifecycle state.");
    }
    if (
      typeof seed.managed !== "boolean" ||
      typeof seed.founder !== "boolean" ||
      typeof seed.willEstablish !== "boolean"
    ) {
      throw new TypeError("Seed lifecycle flags must be boolean.");
    }
    if (seed.sourceTreeId !== null && !isEntityId(seed.sourceTreeId)) {
      throw new TypeError("Seed sourceTreeId is invalid.");
    }
    if (!isFiniteNumber(seed.visualAngle)) {
      throw new TypeError("Seed visualAngle must be finite.");
    }
    if (!isFiniteNumber(seed.suitability) || seed.suitability < 0 || seed.suitability > 1) {
      throw new RangeError("Seed suitability is outside [0, 1].");
    }
    if (
      !isFiniteNumber(seed.establishmentProbability) ||
      seed.establishmentProbability < 0 ||
      seed.establishmentProbability > 1
    ) {
      throw new RangeError("Seed establishment probability is outside [0, 1].");
    }
    if (!isFiniteNumber(seed.outcomeRoll) || seed.outcomeRoll < 0 || seed.outcomeRoll >= 1) {
      throw new RangeError("Seed outcome roll is outside [0, 1).");
    }
    if (!isFiniteNumber(seed.resolutionAge) || seed.resolutionAge < 0) {
      throw new TypeError("Seed resolutionAge must be finite and nonnegative.");
    }
    if (!isFiniteNumber(seed.releaseOffset) || seed.releaseOffset < 0) {
      throw new TypeError("Seed releaseOffset must be finite and nonnegative.");
    }
    if (seed.failureReason !== null && typeof seed.failureReason !== "string") {
      throw new TypeError("Seed failureReason must be a string or null.");
    }
    requireTreeTraits(seed.traits);
  }
  for (const tree of state.trees) {
    if (!isFiniteNumber(tree.size) || tree.size < 0) {
      throw new TypeError("Tree size must be finite and nonnegative.");
    }
    if (!isFiniteNumber(tree.vitality) || tree.vitality < 0 || tree.vitality > 1) {
      throw new RangeError("Tree vitality is outside [0, 1].");
    }
    if (
      typeof tree.managed !== "boolean" ||
      typeof tree.founder !== "boolean" ||
      typeof tree.alive !== "boolean"
    ) {
      throw new TypeError("Tree lifecycle flags must be boolean.");
    }
    if (![...STAGES.map((stage) => stage.name), "dead"].includes(tree.stage)) {
      throw new RangeError("Tree has an invalid lifecycle stage.");
    }
    if (!isFiniteNumber(tree.development) || tree.development < 0) {
      throw new TypeError("Tree development must be finite and nonnegative.");
    }
    if (
      !isFiniteNumber(tree.nurtureApplied) ||
      tree.nurtureApplied < 0 ||
      tree.nurtureApplied > 1
    ) {
      throw new RangeError("Tree nurtureApplied is outside [0, 1].");
    }
    if (!isFiniteNumber(tree.growthVariation) || tree.growthVariation <= 0) {
      throw new TypeError("Tree growthVariation must be finite and positive.");
    }
    if (!isFiniteNumber(tree.mortalityAge) || tree.mortalityAge < 0) {
      throw new TypeError("Tree mortalityAge must be finite and nonnegative.");
    }
    if (
      !isFiniteNumber(tree.siteSuitability) ||
      tree.siteSuitability < 0 ||
      tree.siteSuitability > 1
    ) {
      throw new RangeError("Tree siteSuitability is outside [0, 1].");
    }
  }
  for (const event of state.events) {
    if (
      !event ||
      typeof event.type !== "string" ||
      !isFiniteNumber(event.timeYears) ||
      !isFiniteNumber(event.x) ||
      !isFiniteNumber(event.y) ||
      (event.entityId !== null && !isEntityId(event.entityId)) ||
      (event.reason !== null && typeof event.reason !== "string")
    ) {
      throw new TypeError("Simulation event is invalid.");
    }
  }
  if (state.founderId !== null && !ids.has(state.founderId)) {
    throw new RangeError("founderId does not identify a current entity.");
  }
  const livingCount = state.trees.reduce(
    (count, tree) => count + (tree.alive ? 1 : 0),
    0,
  );
  if (state.stats.alive !== livingCount) {
    throw new RangeError("Simulation alive stat does not match tree state.");
  }
}

function requireTreeTraits(traits) {
  if (
    !traits ||
    !isFiniteNumber(traits.initialVitality) ||
    traits.initialVitality < 0 ||
    traits.initialVitality > 1 ||
    !isFiniteNumber(traits.growthVariation) ||
    traits.growthVariation <= 0 ||
    !isFiniteNumber(traits.mortalityAge) ||
    traits.mortalityAge < 0
  ) {
    throw new TypeError("Seed tree traits are invalid.");
  }
}

function isEntityId(value) {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function isInsideWorld(world, x, y) {
  return (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    x >= 0 &&
    y >= 0 &&
    x < world.width &&
    y < world.height
  );
}

function rejected(reason, details = {}) {
  const serializableDetails = {};
  for (const [key, value] of Object.entries(details)) {
    serializableDetails[key] = value === null || typeof value === "string" || typeof value === "boolean"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? value
        : null;
  }
  return { accepted: false, reason, ...serializableDetails };
}

function explicitFinite(value, fallback) {
  return isFiniteNumber(value) ? value : fallback;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundResource(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundTime(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function roundContinuous(value) {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function worldUpperBound(size) {
  return Math.max(0, size - 1e-9);
}

function hasEntityIdCapacity(state, count) {
  return (
    Number.isSafeInteger(count) &&
    count >= 0 &&
    state.nextEntityId <= Number.MAX_SAFE_INTEGER - count
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clonePlain(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new TypeError(`Simulation state is not serializable: ${error.message}`);
  }
}
