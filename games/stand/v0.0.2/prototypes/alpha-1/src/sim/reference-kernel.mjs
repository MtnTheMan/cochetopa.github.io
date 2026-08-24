import {
  assertJsonValue,
  canonicalByteLength,
  checksumJson,
  cloneJson,
  compareUtf8,
  quantize,
} from "../domain/canonical.mjs";
import {
  createRandomLedger,
  drawUnit,
  stochasticRound,
  validateRandomLedger,
} from "../domain/random.mjs";
import {
  PROPOSED_SYNTHETIC_PARAMETERS_V1,
  assertParameterSet,
} from "./proposed-parameters.mjs";
import {
  aggregateIndividuals,
  conservationSummary,
  refineCohort,
} from "../spatial/ecology/conservation.mjs";

export const KERNEL_CONTRACT_VERSION = "stand-ecological-kernel-port@2";
export const STATE_SCHEMA_VERSION = 3;
export const SNAPSHOT_SCHEMA_VERSION = 3;
export const COMMAND_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const SUGAR_MAPLE_ID = "acer-saccharum";
export const AMBIENT_UNKNOWN_ID = "ambient-unknown";
export const PROTECTED_OFFLINE_POLICY_VERSION = "stand-protected-offline@1";
export const PROTECTED_OFFLINE_MAX_DAYS = 30;
export const SPATIAL_POSITION_FRAME = "stand-local-unitless";
export const SITE_INTERPOLATION_CONTRACT = "inverse-distance-squared-all-sites@1";

const DAYS_PER_SYNTHETIC_YEAR = 365;

const COMMAND_TYPES = new Set([
  "introduce-founder-seed",
  "release-seed-pulse",
  "nurture-tree",
]);
const MANAGEMENT_CLASSES = new Set(["managed", "ambient"]);

export function createReferenceWorld(options = {}) {
  const cells = options.cells ?? [
    {
      cellId: "cell-center",
      x: 0,
      y: 0,
      siteLight01: 0.82,
      suitability01: 0.76,
      growingSpaceStems: 480,
    },
    {
      cellId: "cell-east",
      x: 1,
      y: 0,
      siteLight01: 0.86,
      suitability01: 0.68,
      growingSpaceStems: 420,
    },
    {
      cellId: "cell-north",
      x: 0,
      y: 1,
      siteLight01: 0.74,
      suitability01: 0.58,
      growingSpaceStems: 360,
    },
    {
      cellId: "cell-gap",
      x: -1,
      y: 0,
      siteLight01: 0.9,
      suitability01: 0.72,
      growingSpaceStems: 420,
    },
  ];
  const world = {
    worldSchemaVersion: 1,
    worldId: options.worldId ?? "oneida-synthetic-kernel-fixture@1",
    packageIdentity: options.packageIdentity ?? "synthetic-no-county-package",
    scaleLabel: "synthetic-unitless-stand",
    spatialFrame: "stand-local-unitless",
    crsStatus: "open",
    cells: cloneJson(cells),
    ...(Number.isFinite(options.minimumSupportRadius) ? { minimumSupportRadius: options.minimumSupportRadius } : {}),
  };
  validateWorld(world);
  return world;
}

export function createReferenceState(options = {}) {
  const parameters = options.parameters ?? PROPOSED_SYNTHETIC_PARAMETERS_V1;
  const world = options.world ?? createReferenceWorld();
  assertParameterSet(parameters);
  validateWorld(world);
  const masterSeed = options.masterSeed ?? 0x5a17_0002;
  const state = {
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    ruleVersion: KERNEL_CONTRACT_VERSION,
    parameterSetId: parameters.parameterSetId,
    worldId: world.worldId,
    scaleLabel: world.scaleLabel,
    clock: { step: 0, syntheticYears: 0 },
    random: createRandomLedger(masterSeed),
    nextIds: { entity: 1, event: 1, result: 1, history: 1 },
    rp: { balance: options.initialRp ?? 0, cumulativeEarned: 0, cumulativeSpent: 0 },
    cellState: world.cells.map((cell) => ({
      cellId: cell.cellId,
      livingCanopyPressure01: 0,
      availableLight01: cell.siteLight01,
    })),
    livingTrees: [],
    recruits: [],
    propagules: [],
    cohorts: [],
    snags: [],
    deadwood: [],
    events: [],
    history: [],
    pendingCommands: [],
    processedCommands: [],
    sourceContinuity: {
      sugarMapleStatus: "absent",
      localExtirpationEventEmitted: false,
    },
    counters: {
      cumulativeSeedArrivals: 0,
      cumulativeGerminated: 0,
      cumulativeEstablished: 0,
      cumulativeFailed: 0,
      cumulativePromotions: 0,
      cumulativeBirths: 0,
      cumulativeDeaths: 0,
      cumulativeDecompositions: 0,
      cumulativeRpAwards: 0,
      inventedSeedCount: 0,
    },
    instrumentation: {
      workUnitsLastStep: 0,
      workUnitsMaximum: 0,
      workUnitsTotal: 0,
      compactions: {
        propagules: 0,
        cohorts: 0,
        snags: 0,
        deadwood: 0,
        events: 0,
        history: 0,
        processedCommands: 0,
      },
    },
  };
  installInitialRecords(state, options.initial ?? {});
  normalizeSpatialRecords(state, world);
  updateCanopyLight(state, world, parameters);
  updateSourceContinuity(state);
  validateState(state, world, parameters);
  return state;
}

export function createKernel(options = {}) {
  return new ReferenceKernel(options);
}

export class ReferenceKernel {
  constructor(options = {}) {
    this.parameters = options.parameters ?? PROPOSED_SYNTHETIC_PARAMETERS_V1;
    this.world = options.world ?? createReferenceWorld();
    assertParameterSet(this.parameters);
    validateWorld(this.world);
    this.state = options.state
      ? restoreStateEnvelope(options.state, this.world, this.parameters)
      : createReferenceState({
          world: this.world,
          parameters: this.parameters,
          masterSeed: options.masterSeed,
          initialRp: options.initialRp,
          initial: options.initial,
        });
  }

  contractVersion() {
    return KERNEL_CONTRACT_VERSION;
  }

  apply(commands) {
    if (!Array.isArray(commands)) throw new TypeError("commands must be an array.");
    const startEventId = this.state.nextIds.event;
    const results = [];
    for (const command of [...commands].sort(compareCommands)) {
      results.push(admitOrApplyCommand(this.state, this.world, this.parameters, command));
    }
    validateState(this.state, this.world, this.parameters);
    return cloneJson({
      contractVersion: KERNEL_CONTRACT_VERSION,
      results,
      events: this.state.events.filter(
        (event) => numericSuffix(event.eventId) >= startEventId,
      ),
      checksum: this.checksum(),
    });
  }

  advance(request) {
    const steps = normalizeAdvanceSteps(request);
    const startEventId = this.state.nextIds.event;
    for (let index = 0; index < steps; index += 1) {
      advanceOneStep(this.state, this.world, this.parameters);
    }
    validateState(this.state, this.world, this.parameters);
    return cloneJson({
      contractVersion: KERNEL_CONTRACT_VERSION,
      stepsAdvanced: steps,
      clock: this.state.clock,
      events: this.state.events.filter((event) => numericSuffix(event.eventId) >= startEventId),
      metrics: collectMetrics(this.state, this.world),
      checksum: this.checksum(),
    });
  }

  advanceProtectedOffline(request) {
    const elapsedDays = normalizeProtectedOfflineDays(request);
    const beforeChecksum = this.checksum();
    const beforeDeaths = this.state.counters.cumulativeDeaths;
    const beforeRp = this.state.rp.cumulativeEarned;
    const beforeRandom = cloneJson(this.state.random.drawCounts);
    const startEventId = this.state.nextIds.event;
    advanceProtectedOfflineDays(this.state, this.world, this.parameters, elapsedDays);
    validateState(this.state, this.world, this.parameters);
    const events = this.state.events.filter((event) => numericSuffix(event.eventId) >= startEventId);
    if (events.some((event) => event.type === "ordinary-mortality" || event.type.includes("disturbance"))) {
      throw new RangeError("Protected offline advancement emitted a harmful event.");
    }
    if (this.state.counters.cumulativeDeaths !== beforeDeaths) {
      throw new RangeError("Protected offline advancement changed mortality counters.");
    }
    if (checksumJson(this.state.random.drawCounts) !== checksumJson(beforeRandom)) {
      throw new RangeError("Protected offline advancement consumed random draws.");
    }
    return cloneJson({
      contractVersion: KERNEL_CONTRACT_VERSION,
      policyVersion: PROTECTED_OFFLINE_POLICY_VERSION,
      elapsedDays,
      beforeChecksum,
      afterChecksum: this.checksum(),
      clock: this.state.clock,
      events,
      rpEarned: this.state.rp.cumulativeEarned - beforeRp,
      harmfulInitiations: 0,
      seriousMortalityTransitions: 0,
      mortalityCountDelta: 0,
      randomDrawsConsumed: 0,
      pendingCommandsProcessed: 0,
    });
  }

  snapshot(reason = "explicit") {
    validateState(this.state, this.world, this.parameters);
    const envelope = {
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      kernelContractVersion: KERNEL_CONTRACT_VERSION,
      parameterSetId: this.parameters.parameterSetId,
      worldId: this.world.worldId,
      reason,
      state: cloneJson(this.state),
    };
    assertJsonValue(envelope, "snapshot");
    return envelope;
  }

  restore(snapshot) {
    const restored = restoreStateEnvelope(snapshot, this.world, this.parameters);
    this.state = restored;
    return {
      restored: true,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      clock: cloneJson(this.state.clock),
      checksum: this.checksum(),
    };
  }

  checksum() {
    return checksumJson(this.state);
  }

  inspect(request = { type: "metrics" }) {
    if (request.type === "metrics") return cloneJson(collectMetrics(this.state, this.world));
    if (request.type === "source-continuity") {
      return cloneJson(this.state.sourceContinuity);
    }
    if (request.type === "cell") {
      const cell = this.world.cells.find((candidate) => candidate.cellId === request.cellId);
      const dynamic = this.state.cellState.find((candidate) => candidate.cellId === request.cellId);
      if (!cell || !dynamic) throw new RangeError(`Unknown cell: ${request.cellId}`);
      return cloneJson({ ...cell, ...dynamic });
    }
    if (request.type === "site") {
      return cloneJson(sampleSiteAtPosition(this.world, this.state, request.position));
    }
    if (request.type === "state") return cloneJson(this.state);
    throw new RangeError(`Unknown inspection type: ${request.type}`);
  }

  aggregate(request) {
    const result = aggregateIndividuals(this.state, request, this.parameters);
    updateCanopyLight(this.state, this.world, this.parameters);
    validateState(this.state, this.world, this.parameters);
    return cloneJson({ ...result, checksum: this.checksum() });
  }

  refine(request) {
    const result = refineCohort(
      this.state,
      request,
      this.parameters,
      drawUnit,
    );
    updateCanopyLight(this.state, this.world, this.parameters);
    validateState(this.state, this.world, this.parameters);
    return cloneJson({ ...result, checksum: this.checksum() });
  }
}

function advanceOneStep(state, world, parameters) {
  state.instrumentation.workUnitsLastStep = 0;
  processPendingCommands(state, world, parameters);
  updateCanopyLight(state, world, parameters);
  processPropagules(state, world, parameters);
  processRecruits(state, world, parameters);
  processLivingTrees(state, world, parameters);
  processCohorts(state, world, parameters);
  processDeadMatter(state, parameters);
  updateCanopyLight(state, world, parameters);
  updateSourceContinuity(state);
  state.clock.step += 1;
  state.clock.syntheticYears = quantize(
    state.clock.step * parameters.cadence.yearsPerStep +
      (state.clock.protectedOfflineDays ?? 0) / DAYS_PER_SYNTHETIC_YEAR,
  );
  state.instrumentation.workUnitsTotal += state.instrumentation.workUnitsLastStep;
  state.instrumentation.workUnitsMaximum = Math.max(
    state.instrumentation.workUnitsMaximum,
    state.instrumentation.workUnitsLastStep,
  );
}

function advanceProtectedOfflineDays(state, world, parameters, elapsedDays) {
  if (elapsedDays === 0) return;
  const yearFraction = elapsedDays / DAYS_PER_SYNTHETIC_YEAR;
  state.instrumentation.workUnitsLastStep = 0;
  updateCanopyLight(state, world, parameters);
  processProtectedOfflineLivingTrees(state, world, parameters, elapsedDays, yearFraction);
  processProtectedOfflineCohorts(state, world, parameters, yearFraction);
  processProtectedOfflineRecruits(state, world, parameters, elapsedDays, yearFraction);
  updateCanopyLight(state, world, parameters);
  updateSourceContinuity(state);
  state.clock.protectedOfflineDays = (state.clock.protectedOfflineDays ?? 0) + elapsedDays;
  state.clock.syntheticYears = quantize(
    state.clock.step * parameters.cadence.yearsPerStep +
      state.clock.protectedOfflineDays / DAYS_PER_SYNTHETIC_YEAR,
  );
  state.instrumentation.workUnitsTotal += state.instrumentation.workUnitsLastStep;
  state.instrumentation.workUnitsMaximum = Math.max(
    state.instrumentation.workUnitsMaximum,
    state.instrumentation.workUnitsLastStep,
  );
}

function processProtectedOfflineRecruits(state, world, parameters, elapsedDays, yearFraction) {
  const survivors = [];
  for (const recruit of [...state.recruits].sort(byId)) {
    work(state, 1);
    recruit.offlineAgeDays = (recruit.offlineAgeDays ?? 0) + elapsedDays;
    const light = sampleSiteAtPosition(world, state, recruit.position).availableLight01;
    if (light <= parameters.recruit.suppressedLightAtOrBelow01) {
      recruit.suppressed = true;
      recruit.releaseProgress01 = 0;
    } else if (recruit.suppressed && light >= parameters.recruit.releaseLightAtOrAbove01) {
      recruit.releaseProgress01 = quantize(
        Math.min(1, recruit.releaseProgress01 + parameters.recruit.releaseProgressPerStep01 * yearFraction),
      );
    }
    const growth = recruit.suppressed
      ? parameters.recruit.suppressedGrowthPerStep01 +
        (parameters.recruit.openGrowthPerStep01 - parameters.recruit.suppressedGrowthPerStep01) * recruit.releaseProgress01
      : parameters.recruit.openGrowthPerStep01;
    recruit.development01 = quantize(Math.min(1, recruit.development01 + growth * yearFraction));
    if (!recruit.persistenceRewarded && effectiveAgeYears(recruit) >= parameters.recruit.persistenceAgeSteps) {
      recruit.persistenceRewarded = true;
      awardRp(state, parameters.rewards.recruitPersistenceRp, recruit.cellId, [recruit.id], "recruit-persisted-offline");
    }
    if (recruit.development01 >= parameters.recruit.promotionDevelopment01) {
      promoteRecruit(state, parameters, recruit);
      continue;
    }
    survivors.push(recruit);
  }
  state.recruits = survivors;
}

function processProtectedOfflineLivingTrees(state, world, parameters, elapsedDays, yearFraction) {
  for (const tree of [...state.livingTrees].sort(byId)) {
    work(state, 1);
    tree.offlineAgeDays = (tree.offlineAgeDays ?? 0) + elapsedDays;
    const site = sampleSiteAtPosition(world, state, tree.position);
    const growth = parameters.tree.baseGrowthPerStep01 * (0.5 + 0.5 * site.suitability01) * yearFraction;
    tree.development01 = quantize(Math.min(1, tree.development01 + growth));
    tree.size01 = Math.max(tree.size01, tree.development01);
    const previousStage = tree.stage;
    tree.stage = stageForAge(effectiveAgeYears(tree), parameters);
    tree.reproductive = tree.speciesId === SUGAR_MAPLE_ID && (tree.stage === "mature" || tree.stage === "senescent");
    tree.canopyPressure01 = quantize(tree.size01 * parameters.tree.canopyPerIndividualAtFullSize01);
    if (!tree.maturityRewarded && tree.stage === "mature") {
      tree.maturityRewarded = true;
      awardRp(state, parameters.rewards.individualMaturityRp, tree.cellId, [tree.id], "individual-reached-maturity-offline");
    }
    if (tree.stage !== previousStage) {
      appendEvent(state, {
        type: "tree-stage-changed",
        channel: "ecology",
        process: "protected-offline-growth",
        causeCommandId: null,
        cellId: tree.cellId,
        affectedIds: [tree.id],
        outcomeCode: tree.stage,
        reasonCode: null,
      });
    }
  }
}

function processProtectedOfflineCohorts(state, world, parameters, yearFraction) {
  for (const cohort of [...state.cohorts].sort(byId)) {
    work(state, 1);
    cohort.meanAgeSteps = quantize(cohort.meanAgeSteps + yearFraction);
    const previousStage = cohort.stage;
    cohort.stage = stageForAge(cohort.meanAgeSteps, parameters);
    const site = sampleSiteAtPosition(world, state, cohort.position);
    cohort.meanSize01 = quantize(
      Math.min(1, cohort.meanSize01 + parameters.tree.baseGrowthPerStep01 * (0.5 + 0.5 * site.suitability01) * yearFraction),
    );
    cohort.reproductiveStemCount =
      cohort.speciesId === SUGAR_MAPLE_ID && (cohort.stage === "mature" || cohort.stage === "senescent")
        ? cohort.stemCount
        : 0;
    cohort.canopyPressure01 = canopyForCohort(cohort, parameters);
    if (!cohort.maturityRewarded && cohort.stage === "mature") {
      cohort.maturityRewarded = true;
      awardRp(state, parameters.rewards.cohortMaturityRpPerBatch, cohort.cellId, [cohort.id], "cohort-reached-maturity-offline");
    }
    if (cohort.stage !== previousStage) {
      appendEvent(state, {
        type: "cohort-stage-changed",
        channel: "ecology",
        process: "protected-offline-growth",
        causeCommandId: null,
        cellId: cohort.cellId,
        affectedIds: [cohort.id],
        outcomeCode: cohort.stage,
        reasonCode: null,
        count: cohort.stemCount,
      });
    }
  }
}

function processPendingCommands(state, world, parameters) {
  const due = state.pendingCommands
    .filter((command) => command.targetStep === state.clock.step)
    .sort(compareCommands);
  state.pendingCommands = state.pendingCommands.filter(
    (command) => command.targetStep !== state.clock.step,
  );
  for (const command of due) applyAdmittedCommand(state, world, parameters, command);
}

function admitOrApplyCommand(state, world, parameters, rawCommand) {
  const command = validateAndCloneCommand(rawCommand);
  const prior = state.processedCommands.find(
    (entry) =>
      entry.commandId === command.commandId ||
      entry.idempotencyKey === command.idempotencyKey,
  );
  if (prior) return cloneJson(prior.result);
  if (state.processedCommands.length >= parameters.bounds.processedCommands) {
    compactProcessedCommands(state, parameters, 1);
  }
  if (state.processedCommands.length >= parameters.bounds.processedCommands) {
    return rejectedCommand("command-ledger-pending-capacity");
  }
  if (command.targetStep < state.clock.step) return rejectedCommand("stale-command");
  if (command.targetStep > state.clock.step) {
    if (state.pendingCommands.length >= parameters.bounds.processedCommands) {
      return rejectedCommand("pending-command-capacity");
    }
    state.pendingCommands.push(command);
    state.pendingCommands.sort(compareCommands);
    const result = {
      status: "accepted-pending",
      commandId: command.commandId,
      targetStep: command.targetStep,
    };
    recordProcessedCommand(state, command, result);
    return cloneJson(result);
  }
  return applyAdmittedCommand(state, world, parameters, command);
}

function applyAdmittedCommand(state, world, parameters, command) {
  let result;
  if (command.type === "introduce-founder-seed") {
    result = introduceFounderSeed(state, world, parameters, command);
  } else if (command.type === "release-seed-pulse") {
    result = releaseSeedPulse(state, world, parameters, command);
  } else if (command.type === "nurture-tree") {
    result = nurtureTree(state, parameters, command);
  } else {
    result = rejectedCommand("unsupported-command");
  }
  recordProcessedCommand(state, command, result);
  return cloneJson(result);
}

function introduceFounderSeed(state, world, parameters, command) {
  if (command.source !== "system" && command.source !== "player") {
    return rejectedCommand("founder-authority-required");
  }
  if (typeof command.payload.provenanceId !== "string" || !command.payload.provenanceId) {
    return rejectedCommand("founder-provenance-required");
  }
  const hasManagedLineage =
    state.livingTrees.some((tree) => tree.managementClass === "managed") ||
    state.cohorts.some((cohort) => cohort.managementClass === "managed") ||
    state.recruits.some((recruit) => recruit.managementClass === "managed") ||
    state.propagules.some((propagule) => propagule.managementClass === "managed");
  if (hasManagedLineage) return rejectedCommand("managed-lineage-already-present");
  const cell = requireCell(world, command.payload.cellId);
  if (state.propagules.length >= parameters.bounds.propaguleBins) {
    return rejectedCommand("propagule-capacity");
  }
  const propagule = createPropagule(state, {
    speciesId: SUGAR_MAPLE_ID,
    managementClass: "managed",
    cellId: cell.cellId,
    position: positionAtCell(cell),
    seedCount: 1,
    sourceKind: "explicit-founder-provenance",
    sourceEntityId: null,
    provenance: command.payload.provenanceId,
    causeCommandId: command.commandId,
    featuredOnPromotion: true,
    individualOnPromotion: true,
  });
  state.propagules.push(propagule);
  state.counters.cumulativeSeedArrivals += 1;
  state.counters.cumulativeBirths += 1;
  const event = appendEvent(state, {
    type: "seed-arrived",
    channel: "ecology",
    process: "founder-introduction",
    causeCommandId: command.commandId,
    cellId: cell.cellId,
    affectedIds: [propagule.id],
    outcomeCode: "explicit-founder-seed-arrived",
    reasonCode: null,
  });
  state.sourceContinuity.localExtirpationEventEmitted = false;
  return acceptedCommand(state, command, {
    seedId: propagule.id,
    releaseId: allocateId(state, "release"),
    eventId: event.eventId,
  });
}

function releaseSeedPulse(state, world, parameters, command) {
  const source = findLivingSource(state, command.payload.sourceEntityId);
  if (!source || source.speciesId !== SUGAR_MAPLE_ID || !source.reproductive) {
    return rejectedCommand("source-ineligible");
  }
  if (state.rp.balance < parameters.propagule.seedCostRp) {
    return rejectedCommand("insufficient-rp");
  }
  if (state.propagules.length >= parameters.bounds.propaguleBins) {
    return rejectedCommand("propagule-capacity");
  }
  const direction = validateDirection(command.payload.direction);
  const landing = displacedLanding(state, world, parameters, source, direction, command);
  const propagule = createPropagule(state, {
    speciesId: SUGAR_MAPLE_ID,
    managementClass: source.managementClass,
    cellId: landing.cell.cellId,
    position: landing.position,
    seedCount: 1,
    sourceKind: command.payload.mode === "automatic" ? "automated-release" : "direct-release",
    sourceEntityId: source.id,
    provenance: source.provenance,
    causeCommandId: command.commandId,
    featuredOnPromotion: false,
    individualOnPromotion: true,
  });
  state.propagules.push(propagule);
  state.rp.balance -= parameters.propagule.seedCostRp;
  state.rp.cumulativeSpent += parameters.propagule.seedCostRp;
  state.counters.cumulativeSeedArrivals += 1;
  state.counters.cumulativeBirths += 1;
  const event = appendEvent(state, {
    type: "seed-released",
    channel: "ecology",
    process: "samara-dispersal",
    causeCommandId: command.commandId,
    cellId: landing.cell.cellId,
    affectedIds: [source.id, propagule.id],
    outcomeCode: "sugar-maple-samara-released",
    reasonCode: null,
  });
  return acceptedCommand(state, command, {
    seedId: propagule.id,
    releaseId: allocateId(state, "release"),
    eventId: event.eventId,
  });
}

function nurtureTree(state, parameters, command) {
  const tree = state.livingTrees.find((candidate) => candidate.id === command.payload.targetEntityId);
  const recruit = state.recruits.find((candidate) => candidate.id === command.payload.targetEntityId);
  const target = tree ?? recruit;
  if (!target) return rejectedCommand("target-not-found");
  if (target.managementClass !== "managed") return rejectedCommand("target-not-managed");
  if (tree) {
    tree.nurturePending01 = quantize(
      Math.min(1, tree.nurturePending01 + parameters.tree.nurtureGrowthAdvance01),
    );
  } else {
    recruit.development01 = quantize(
      Math.min(1, recruit.development01 + parameters.tree.nurtureGrowthAdvance01),
    );
  }
  return {
    status: "accepted",
    resultId: allocateId(state, "result"),
    commandId: command.commandId,
    reasonCode: "eligible-managed-living-target",
    directSeedCreated: 0,
    directRpAwarded: 0,
    targetEntityId: target.id,
  };
}

function processPropagules(state, world, parameters) {
  const survivors = [];
  for (const bin of [...state.propagules].sort(byId)) {
    work(state, 1);
    bin.ageSteps += 1;
    const cell = requireCell(world, bin.cellId);
    const site = sampleSiteAtPosition(world, state, bin.position);
    const light = site.availableLight01;
    if (bin.ageSteps === parameters.propagule.germinationAgeSteps) {
      const germinationFactor = parameters.propagule.baseGermination01 * (0.5 + 0.5 * site.suitability01);
      bin.germinatedCount = Math.min(
        bin.seedCount,
        stochasticRound(state, "germination", bin.seedCount * germinationFactor, bin.id, state.clock.step),
      );
      state.counters.cumulativeGerminated += bin.germinatedCount;
      appendEvent(state, {
        type: "germination-attempted",
        channel: "ecology",
        process: "germination",
        causeCommandId: bin.causeCommandId,
        cellId: bin.cellId,
        affectedIds: [bin.id],
        outcomeCode: "germination-resolved",
        reasonCode: null,
        count: bin.germinatedCount,
      });
    }
    if (bin.ageSteps < parameters.propagule.resolutionAgeSteps) {
      survivors.push(bin);
      continue;
    }
    const availableSpace = Math.max(
      0,
      cellCapacity(cell, parameters) - representedGrowingSpaceAtCell(state, bin.cellId),
    );
    const siteFactor = 0.35 + 0.65 * site.suitability01;
    const lightFactor = 0.2 + 0.8 * light;
    const establishmentProbability = Math.min(
      1,
      parameters.propagule.baseEstablishment01 * siteFactor * lightFactor,
    );
    const established = Math.min(
      availableSpace,
      stochasticRound(
        state,
        "establishment",
        bin.germinatedCount * establishmentProbability,
        bin.id,
        state.clock.step,
      ),
    );
    const failed = bin.seedCount - established;
    if (established > 0) {
      addRecruit(state, parameters, {
        speciesId: bin.speciesId,
        managementClass: bin.managementClass,
        cellId: bin.cellId,
        position: bin.position,
        stemCount: established,
        provenance: bin.provenance,
        featuredOnPromotion: bin.featuredOnPromotion && established === 1,
        individualOnPromotion: bin.individualOnPromotion && established === 1,
      });
      state.counters.cumulativeEstablished += established;
      appendEvent(state, {
        type: "recruit-established",
        channel: "ecology",
        process: "establishment",
        causeCommandId: bin.causeCommandId,
        cellId: bin.cellId,
        affectedIds: [bin.id],
        outcomeCode: "seedling-entered-recruit-store",
        reasonCode: null,
        count: established,
      });
    }
    if (failed > 0) {
      state.counters.cumulativeFailed += failed;
      appendEvent(state, {
        type: "establishment-failed",
        channel: "ecology",
        process: "establishment",
        causeCommandId: bin.causeCommandId,
        cellId: bin.cellId,
        affectedIds: [bin.id],
        outcomeCode: "seed-attempt-failed",
        reasonCode: availableSpace === 0 ? "growing-space-unavailable" : "fixture-microsite-outcome",
        count: failed,
      });
    }
  }
  state.propagules = survivors;
}

function processRecruits(state, world, parameters) {
  const survivors = [];
  for (const recruit of [...state.recruits].sort(byId)) {
    work(state, 1);
    recruit.ageSteps += 1;
    const site = sampleSiteAtPosition(world, state, recruit.position);
    const light = site.availableLight01;
    if (light <= parameters.recruit.suppressedLightAtOrBelow01) {
      recruit.suppressed = true;
      recruit.releaseProgress01 = 0;
    } else if (recruit.suppressed && light >= parameters.recruit.releaseLightAtOrAbove01) {
      const previous = recruit.releaseProgress01;
      recruit.releaseProgress01 = quantize(
        Math.min(1, recruit.releaseProgress01 + parameters.recruit.releaseProgressPerStep01),
      );
      if (previous === 0) {
        appendEvent(state, {
          type: "gap-release-began",
          channel: "ecology",
          process: "advance-regeneration-release",
          causeCommandId: null,
          cellId: recruit.cellId,
          affectedIds: [recruit.id],
          outcomeCode: "suppressed-recruit-releasing",
          reasonCode: null,
          count: recruit.stemCount,
        });
      }
    }
    const survival = recruit.suppressed
      ? parameters.recruit.suppressedAnnualSurvival01
      : parameters.recruit.baseAnnualSurvival01;
    const survived = Math.min(
      recruit.stemCount,
      stochasticRound(
        state,
        "recruit-survival",
        recruit.stemCount * survival * (0.8 + 0.2 * site.suitability01),
        recruit.id,
        state.clock.step,
      ),
    );
    const died = recruit.stemCount - survived;
    if (died > 0) state.counters.cumulativeDeaths += died;
    recruit.stemCount = survived;
    if (survived === 0) continue;
    const growth = recruit.suppressed
      ? parameters.recruit.suppressedGrowthPerStep01 +
        (parameters.recruit.openGrowthPerStep01 - parameters.recruit.suppressedGrowthPerStep01) *
          recruit.releaseProgress01
      : parameters.recruit.openGrowthPerStep01;
    recruit.development01 = quantize(Math.min(1, recruit.development01 + growth));
    if (!recruit.persistenceRewarded && effectiveAgeYears(recruit) >= parameters.recruit.persistenceAgeSteps) {
      recruit.persistenceRewarded = true;
      awardRp(
        state,
        parameters.rewards.recruitPersistenceRp,
        recruit.cellId,
        [recruit.id],
        "recruit-persisted",
      );
    }
    if (recruit.development01 >= parameters.recruit.promotionDevelopment01) {
      promoteRecruit(state, parameters, recruit);
      continue;
    }
    survivors.push(recruit);
  }
  state.recruits = survivors;
}

function processLivingTrees(state, world, parameters) {
  const survivors = [];
  for (const tree of [...state.livingTrees].sort(byId)) {
    work(state, 1);
    tree.ageSteps += 1;
    const site = sampleSiteAtPosition(world, state, tree.position);
    const growth = parameters.tree.baseGrowthPerStep01 * (0.5 + 0.5 * site.suitability01);
    tree.development01 = quantize(
      Math.min(1, tree.development01 + growth + tree.nurturePending01),
    );
    tree.nurturePending01 = 0;
    tree.size01 = Math.max(tree.size01, tree.development01);
    const previousStage = tree.stage;
    tree.stage = stageForAge(effectiveAgeYears(tree), parameters);
    tree.reproductive =
      tree.speciesId === SUGAR_MAPLE_ID &&
      (tree.stage === "mature" || tree.stage === "senescent");
    tree.canopyPressure01 = quantize(
      tree.size01 * parameters.tree.canopyPerIndividualAtFullSize01,
    );
    if (!tree.maturityRewarded && tree.stage === "mature") {
      tree.maturityRewarded = true;
      awardRp(
        state,
        parameters.rewards.individualMaturityRp,
        tree.cellId,
        [tree.id],
        "individual-reached-maturity",
      );
    }
    if (tree.reproductive) createNaturalSeedPressure(state, world, parameters, tree, 1);
    const mortality = mortalityForStage(tree.stage, parameters.tree);
    const dies =
      effectiveAgeYears(tree) >= parameters.tree.maximumAgeSteps ||
      drawUnit(state, "mortality", tree.id, state.clock.step) < mortality;
    if (dies) {
      state.counters.cumulativeDeaths += 1;
      addSnag(state, parameters, tree, 1);
      appendMortalityAndGapEvents(state, tree, 1);
      continue;
    }
    if (tree.stage !== previousStage) {
      appendEvent(state, {
        type: "tree-stage-changed",
        channel: "ecology",
        process: "growth",
        causeCommandId: null,
        cellId: tree.cellId,
        affectedIds: [tree.id],
        outcomeCode: tree.stage,
        reasonCode: null,
      });
    }
    survivors.push(tree);
  }
  state.livingTrees = survivors;
}

function processCohorts(state, world, parameters) {
  const survivors = [];
  for (const cohort of [...state.cohorts].sort(byId)) {
    work(state, 1);
    cohort.meanAgeSteps = quantize(cohort.meanAgeSteps + 1);
    const previousStage = cohort.stage;
    cohort.stage = stageForAge(cohort.meanAgeSteps, parameters);
    const mortality = mortalityForStage(cohort.stage, parameters.cohort);
    const died = Math.min(
      cohort.stemCount,
      stochasticRound(
        state,
        "mortality",
        cohort.stemCount * mortality,
        cohort.id,
        state.clock.step,
      ),
    );
    cohort.stemCount -= died;
    state.counters.cumulativeDeaths += died;
    if (died > 0) {
      addSnag(state, parameters, cohort, died);
      appendMortalityAndGapEvents(state, cohort, died);
    }
    if (cohort.stemCount === 0) continue;
    const site = sampleSiteAtPosition(world, state, cohort.position);
    cohort.meanSize01 = quantize(
      Math.min(1, cohort.meanSize01 + parameters.tree.baseGrowthPerStep01 * (0.5 + 0.5 * site.suitability01)),
    );
    cohort.reproductiveStemCount =
      cohort.speciesId === SUGAR_MAPLE_ID &&
      (cohort.stage === "mature" || cohort.stage === "senescent")
        ? cohort.stemCount
        : 0;
    cohort.canopyPressure01 = canopyForCohort(cohort, parameters);
    if (!cohort.maturityRewarded && cohort.stage === "mature") {
      cohort.maturityRewarded = true;
      awardRp(
        state,
        parameters.rewards.cohortMaturityRpPerBatch,
        cohort.cellId,
        [cohort.id],
        "cohort-reached-maturity",
      );
    }
    if (cohort.reproductiveStemCount > 0) {
      createNaturalSeedPressure(
        state,
        world,
        parameters,
        cohort,
        cohort.reproductiveStemCount,
      );
    }
    if (cohort.stage !== previousStage) {
      appendEvent(state, {
        type: "cohort-stage-changed",
        channel: "ecology",
        process: "growth",
        causeCommandId: null,
        cellId: cohort.cellId,
        affectedIds: [cohort.id],
        outcomeCode: cohort.stage,
        reasonCode: null,
        count: cohort.stemCount,
      });
    }
    survivors.push(cohort);
  }
  state.cohorts = survivors;
  coalesceCohorts(state, parameters);
}

function processDeadMatter(state, parameters) {
  const remainingSnags = [];
  for (const snag of [...state.snags].sort(byId)) {
    work(state, 1);
    snag.ageSteps += 1;
    if (snag.ageSteps >= parameters.deadMatter.snagResidenceSteps) {
      addDeadwood(state, parameters, snag, snag.stemCount);
    } else {
      remainingSnags.push(snag);
    }
  }
  state.snags = remainingSnags;
  const remainingDeadwood = [];
  for (const pool of [...state.deadwood].sort(byId)) {
    work(state, 1);
    pool.ageSteps += 1;
    if (pool.ageSteps >= parameters.deadMatter.deadwoodResidenceSteps) {
      state.counters.cumulativeDecompositions += pool.stemCount;
      appendHistory(state, parameters, "deadwood-decomposed", pool.stemCount);
    } else {
      remainingDeadwood.push(pool);
    }
  }
  state.deadwood = remainingDeadwood;
}

function updateCanopyLight(state, world, parameters) {
  for (const cell of world.cells) {
    const individualPressure = state.livingTrees
      .filter((tree) => tree.cellId === cell.cellId)
      .reduce((sum, tree) => sum + tree.canopyPressure01, 0);
    const cohortPressure = state.cohorts
      .filter((cohort) => cohort.cellId === cell.cellId)
      .reduce((sum, cohort) => sum + cohort.canopyPressure01, 0);
    const pressure = quantize(
      Math.min(
        parameters.light.maximumLivingCanopyPressure01,
        individualPressure + cohortPressure,
      ),
    );
    const dynamic = requireCellState(state, cell.cellId);
    dynamic.livingCanopyPressure01 = pressure;
    dynamic.availableLight01 = quantize(cell.siteLight01 * (1 - pressure));
  }
}

function updateSourceContinuity(state) {
  const sugarLiving =
    state.livingTrees.filter((tree) => tree.speciesId === SUGAR_MAPLE_ID).length +
    state.cohorts
      .filter((cohort) => cohort.speciesId === SUGAR_MAPLE_ID)
      .reduce((sum, cohort) => sum + cohort.stemCount, 0);
  const sugarRecruits = state.recruits
    .filter((recruit) => recruit.speciesId === SUGAR_MAPLE_ID)
    .reduce((sum, recruit) => sum + recruit.stemCount, 0);
  const sugarPropagules = state.propagules
    .filter((propagule) => propagule.speciesId === SUGAR_MAPLE_ID)
    .reduce((sum, bin) => sum + bin.seedCount, 0);
  const reproductive =
    state.livingTrees.filter((tree) => tree.speciesId === SUGAR_MAPLE_ID && tree.reproductive).length +
    state.cohorts
      .filter((cohort) => cohort.speciesId === SUGAR_MAPLE_ID)
      .reduce((sum, cohort) => sum + cohort.reproductiveStemCount, 0);
  if (sugarLiving + sugarRecruits + sugarPropagules === 0) {
    state.sourceContinuity.sugarMapleStatus = "locally-extirpated";
    if (!state.sourceContinuity.localExtirpationEventEmitted) {
      appendEvent(state, {
        type: "local-source-extirpated",
        channel: "ecology",
        process: "source-continuity",
        causeCommandId: null,
        cellId: null,
        affectedIds: [],
        outcomeCode: "no-living-no-propagule-no-advance-regeneration",
        reasonCode: "local-source-paths-lost",
      });
      state.sourceContinuity.localExtirpationEventEmitted = true;
    }
  } else if (reproductive > 0) {
    state.sourceContinuity.sugarMapleStatus = "reproductive-source-present";
    state.sourceContinuity.localExtirpationEventEmitted = false;
  } else if (sugarPropagules > 0) {
    state.sourceContinuity.sugarMapleStatus = "recent-propagule-present";
    state.sourceContinuity.localExtirpationEventEmitted = false;
  } else if (sugarRecruits > 0) {
    state.sourceContinuity.sugarMapleStatus = "advance-regeneration-present";
    state.sourceContinuity.localExtirpationEventEmitted = false;
  } else {
    state.sourceContinuity.sugarMapleStatus = "nonreproductive-living-present";
    state.sourceContinuity.localExtirpationEventEmitted = false;
  }
}

function createNaturalSeedPressure(state, world, parameters, source, reproductiveStems) {
  const expected = Math.min(
    parameters.propagule.maximumNaturalSeedsPerSourcePerStep,
    reproductiveStems * parameters.propagule.naturalSeedsPerReproductiveStem,
  );
  const count = stochasticRound(
    state,
    "reproduction",
    expected,
    source.id,
    state.clock.step,
  );
  if (count <= 0) return;
  const landing = naturalLanding(state, world, parameters, source);
  const existing = state.propagules.find(
    (bin) =>
      bin.sourceKind === "natural-seed-pressure" &&
      bin.cellId === landing.cell.cellId &&
      bin.speciesId === source.speciesId &&
      bin.managementClass === source.managementClass &&
      bin.ageSteps === 0,
  );
  if (existing) {
    existing.position = weightedPosition(
      existing.position,
      existing.seedCount,
      landing.position,
      count,
    );
    existing.seedCount += count;
    state.instrumentation.compactions.propagules += 1;
  } else if (state.propagules.length < parameters.bounds.propaguleBins) {
    state.propagules.push(
      createPropagule(state, {
        speciesId: source.speciesId,
        managementClass: source.managementClass,
        cellId: landing.cell.cellId,
        position: landing.position,
        seedCount: count,
        sourceKind: "natural-seed-pressure",
        sourceEntityId: source.id,
        provenance: source.provenance,
        causeCommandId: null,
        featuredOnPromotion: false,
        individualOnPromotion: false,
      }),
    );
  } else {
    state.instrumentation.compactions.propagules += 1;
    return;
  }
  state.counters.cumulativeSeedArrivals += count;
  state.counters.cumulativeBirths += count;
}

function promoteRecruit(state, parameters, recruit) {
  state.counters.cumulativePromotions += recruit.stemCount;
  if (
    recruit.individualOnPromotion &&
    recruit.stemCount === 1 &&
    state.livingTrees.length < parameters.bounds.individuals
  ) {
    const tree = {
      id: allocateId(state, "tree"),
      speciesId: recruit.speciesId,
      managementClass: recruit.managementClass,
      cellId: recruit.cellId,
      position: clonePosition(recruit.position),
      stage: "juvenile",
      ageSteps: recruit.ageSteps,
      ...(recruit.offlineAgeDays ? { offlineAgeDays: recruit.offlineAgeDays } : {}),
      development01: recruit.development01,
      size01: recruit.development01,
      canopyPressure01: quantize(
        recruit.development01 * parameters.tree.canopyPerIndividualAtFullSize01,
      ),
      reproductive: false,
      provenance: recruit.provenance,
      featured: recruit.featuredOnPromotion,
      founder: recruit.featuredOnPromotion,
      maturityRewarded: false,
      nurturePending01: 0,
    };
    state.livingTrees.push(tree);
    appendEvent(state, {
      type: "tree-promoted",
      channel: "ecology",
      process: "recruitment",
      causeCommandId: null,
      cellId: tree.cellId,
      affectedIds: [recruit.id, tree.id],
      outcomeCode: recruit.featuredOnPromotion ? "featured-founder-tree" : "spatial-individual-tree",
      reasonCode: null,
    });
    return;
  }
  addOrMergeCohort(state, parameters, {
    speciesId: recruit.speciesId,
    managementClass: recruit.managementClass,
    cellId: recruit.cellId,
    position: recruit.position,
    stage: "juvenile",
    stemCount: recruit.stemCount,
    meanAgeSteps: effectiveAgeYears(recruit),
    meanSize01: recruit.development01,
    provenance: recruit.provenance,
    maturityRewarded: false,
  });
  appendEvent(state, {
    type: "cohort-promoted",
    channel: "ecology",
    process: "recruitment",
    causeCommandId: null,
    cellId: recruit.cellId,
    affectedIds: [recruit.id],
    outcomeCode: "recruit-batch-entered-living-cohort",
    reasonCode: null,
    count: recruit.stemCount,
  });
}

function addRecruit(state, parameters, input) {
  const compatible = state.recruits.find(
    (recruit) =>
      recruit.speciesId === input.speciesId &&
      recruit.managementClass === input.managementClass &&
      recruit.cellId === input.cellId &&
      recruit.provenance === input.provenance &&
      recruit.ageSteps === 0 &&
      samePosition(recruit.position, input.position) &&
      !recruit.featuredOnPromotion &&
      !recruit.individualOnPromotion &&
      !input.featuredOnPromotion &&
      !input.individualOnPromotion,
  );
  if (compatible) {
    compatible.stemCount += input.stemCount;
    return compatible;
  }
  if (state.recruits.length >= parameters.bounds.recruits) {
    const fallback = state.recruits.find(
      (recruit) =>
        recruit.speciesId === input.speciesId &&
        recruit.managementClass === input.managementClass &&
        recruit.cellId === input.cellId,
    );
    if (!fallback) throw new RangeError("Recruit cap cannot preserve an incompatible identity.");
    fallback.position = weightedPosition(
      fallback.position,
      fallback.stemCount,
      input.position,
      input.stemCount,
    );
    fallback.stemCount += input.stemCount;
    return fallback;
  }
  const recruit = {
    id: allocateId(state, "recruit"),
    speciesId: input.speciesId,
    managementClass: input.managementClass,
    cellId: input.cellId,
    position: clonePosition(input.position),
    stemCount: input.stemCount,
    ageSteps: 0,
    development01: 0,
    suppressed: false,
    releaseProgress01: 0,
    persistenceRewarded: false,
    provenance: input.provenance,
    featuredOnPromotion: input.featuredOnPromotion,
    individualOnPromotion: input.individualOnPromotion,
  };
  state.recruits.push(recruit);
  return recruit;
}

function addOrMergeCohort(state, parameters, input) {
  const existing = state.cohorts.find(
    (cohort) =>
      cohort.speciesId === input.speciesId &&
      cohort.managementClass === input.managementClass &&
      cohort.cellId === input.cellId &&
      cohort.stage === input.stage &&
      cohort.provenance === input.provenance &&
      cohort.maturityRewarded === input.maturityRewarded,
  );
  if (existing) {
    const total = existing.stemCount + input.stemCount;
    existing.position = weightedPosition(
      existing.position,
      existing.stemCount,
      input.position,
      input.stemCount,
    );
    existing.meanAgeSteps = quantize(
      (existing.meanAgeSteps * existing.stemCount + input.meanAgeSteps * input.stemCount) / total,
    );
    existing.meanSize01 = quantize(
      (existing.meanSize01 * existing.stemCount + input.meanSize01 * input.stemCount) / total,
    );
    existing.stemCount = total;
    existing.reproductiveStemCount =
      existing.speciesId === SUGAR_MAPLE_ID &&
      (existing.stage === "mature" || existing.stage === "senescent")
        ? total
        : 0;
    existing.canopyPressure01 = canopyForCohort(existing, parameters);
    state.instrumentation.compactions.cohorts += 1;
    return existing;
  }
  if (state.cohorts.length >= parameters.bounds.cohorts) {
    throw new RangeError("Cohort capacity reached without a compatible conservation bin.");
  }
  const cohort = {
    id: allocateId(state, "cohort"),
    speciesId: input.speciesId,
    managementClass: input.managementClass,
    cellId: input.cellId,
    position: clonePosition(input.position),
    stage: input.stage,
    stemCount: input.stemCount,
    meanAgeSteps: input.meanAgeSteps,
    meanSize01: input.meanSize01,
    canopyPressure01: 0,
    reproductiveStemCount:
      input.speciesId === SUGAR_MAPLE_ID &&
      (input.stage === "mature" || input.stage === "senescent")
        ? input.stemCount
        : 0,
    provenance: input.provenance,
    maturityRewarded: input.maturityRewarded,
  };
  cohort.canopyPressure01 = canopyForCohort(cohort, parameters);
  state.cohorts.push(cohort);
  return cohort;
}

function coalesceCohorts(state, parameters) {
  const ordered = [...state.cohorts].sort(byId);
  state.cohorts = [];
  for (const cohort of ordered) {
    addOrMergeCohort(state, parameters, cohort);
  }
}

function addSnag(state, parameters, source, stemCount) {
  addBoundedPool(state, parameters, "snags", {
    id: allocateId(state, "snag"),
    speciesId: source.speciesId,
    managementClass: source.managementClass,
    cellId: source.cellId,
    position: clonePosition(source.position),
    stemCount,
    ageSteps: 0,
    provenance: source.provenance,
  });
}

function addDeadwood(state, parameters, source, stemCount) {
  addBoundedPool(state, parameters, "deadwood", {
    id: allocateId(state, "deadwood"),
    speciesId: source.speciesId,
    managementClass: source.managementClass,
    cellId: source.cellId,
    position: clonePosition(source.position),
    stemCount,
    ageSteps: 0,
    provenance: source.provenance,
  });
}

function addBoundedPool(state, parameters, storeName, record) {
  const limit = storeName === "snags" ? parameters.bounds.snags : parameters.bounds.deadwoodPools;
  const store = state[storeName];
  const compatible = store.find(
    (candidate) =>
      candidate.speciesId === record.speciesId &&
      candidate.managementClass === record.managementClass &&
      candidate.cellId === record.cellId &&
      candidate.ageSteps === record.ageSteps,
  );
  if (compatible) {
    compatible.position = weightedPosition(
      compatible.position,
      compatible.stemCount,
      record.position,
      record.stemCount,
    );
    compatible.stemCount += record.stemCount;
    state.instrumentation.compactions[storeName === "snags" ? "snags" : "deadwood"] += 1;
    return;
  }
  if (store.length < limit) {
    store.push(record);
    return;
  }
  const oldest = [...store].sort((left, right) => right.ageSteps - left.ageSteps || compareUtf8(left.id, right.id))[0];
  oldest.position = weightedPosition(
    oldest.position,
    oldest.stemCount,
    record.position,
    record.stemCount,
  );
  oldest.stemCount += record.stemCount;
  state.instrumentation.compactions[storeName === "snags" ? "snags" : "deadwood"] += 1;
}

function appendMortalityAndGapEvents(state, source, count) {
  appendEvent(state, {
    type: "ordinary-mortality",
    channel: "ecology",
    process: "ordinary-mortality",
    causeCommandId: null,
    cellId: source.cellId,
    affectedIds: [source.id],
    outcomeCode: "living-stems-died",
    reasonCode: "ordinary-mortality",
    count,
  });
  appendEvent(state, {
    type: "canopy-gap-opened",
    channel: "ecology",
    process: "canopy-light",
    causeCommandId: null,
    cellId: source.cellId,
    affectedIds: [source.id],
    outcomeCode: "dead-crown-removed-from-living-canopy",
    reasonCode: null,
    count,
  });
}

function awardRp(state, amount, cellId, affectedIds, outcomeCode) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  state.rp.balance += amount;
  state.rp.cumulativeEarned += amount;
  state.counters.cumulativeRpAwards += amount;
  appendEvent(state, {
    type: "rp-awarded",
    channel: "economy",
    process: "qualifying-regeneration",
    causeCommandId: null,
    cellId,
    affectedIds,
    outcomeCode,
    reasonCode: null,
    rpDelta: amount,
  });
}

function appendEvent(state, input) {
  const event = {
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `event-${state.nextIds.event}`,
    sequence: state.nextIds.event,
    step: state.clock.step,
    type: input.type,
    channel: input.channel,
    process: input.process,
    causeCommandId: input.causeCommandId ?? null,
    cellId: input.cellId ?? null,
    affectedIds: input.affectedIds ?? [],
    outcomeCode: input.outcomeCode,
    reasonCode: input.reasonCode ?? null,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.rpDelta === undefined ? {} : { rpDelta: input.rpDelta }),
  };
  state.nextIds.event += 1;
  state.events.push(event);
  const limit = PROPOSED_SYNTHETIC_PARAMETERS_V1.bounds.retainedEvents;
  if (state.events.length > limit) {
    const evicted = state.events.length - limit;
    state.events.splice(0, evicted);
    state.instrumentation.compactions.events += evicted;
    appendHistory(state, PROPOSED_SYNTHETIC_PARAMETERS_V1, "event-history-compacted", evicted);
  }
  return event;
}

function appendHistory(state, parameters, type, count) {
  const last = state.history.at(-1);
  if (last && last.type === type && last.step === state.clock.step) {
    last.count += count;
    return;
  }
  state.history.push({
    historyId: `history-${state.nextIds.history}`,
    step: state.clock.step,
    type,
    count,
  });
  state.nextIds.history += 1;
  if (state.history.length > parameters.bounds.retainedHistory) {
    const evicted = state.history.length - parameters.bounds.retainedHistory;
    state.history.splice(0, evicted);
    state.instrumentation.compactions.history += evicted;
  }
}

function collectMetrics(state, world) {
  const cohortStemCount = state.cohorts.reduce((sum, cohort) => sum + cohort.stemCount, 0);
  const recruitStemCount = state.recruits.reduce((sum, recruit) => sum + recruit.stemCount, 0);
  const propaguleCount = state.propagules.reduce((sum, bin) => sum + bin.seedCount, 0);
  return {
    clockStep: state.clock.step,
    syntheticYears: state.clock.syntheticYears,
    protectedOfflineDays: state.clock.protectedOfflineDays ?? 0,
    activeCells: world.cells.length,
    individuals: state.livingTrees.length,
    recruits: state.recruits.length,
    recruitStemCount,
    propaguleBins: state.propagules.length,
    propaguleCount,
    cohorts: state.cohorts.length,
    cohortStemCount,
    representedLivingStemCount: state.livingTrees.length + cohortStemCount,
    snags: state.snags.length,
    snagStemCount: state.snags.reduce((sum, snag) => sum + snag.stemCount, 0),
    deadwoodPools: state.deadwood.length,
    deadwoodStemCount: state.deadwood.reduce((sum, pool) => sum + pool.stemCount, 0),
    retainedEvents: state.events.length,
    retainedHistory: state.history.length,
    pendingCommands: state.pendingCommands.length,
    processedCommands: state.processedCommands.length,
    stepWorkUnits: state.instrumentation.workUnitsLastStep,
    maximumStepWorkUnits: state.instrumentation.workUnitsMaximum,
    compactions: cloneJson(state.instrumentation.compactions),
    rp: cloneJson(state.rp),
    sourceStatus: state.sourceContinuity.sugarMapleStatus,
    checksum: checksumJson(state),
    snapshotBytes: canonicalByteLength({
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      kernelContractVersion: KERNEL_CONTRACT_VERSION,
      parameterSetId: state.parameterSetId,
      worldId: state.worldId,
      reason: "metrics",
      state,
    }),
  };
}

function restoreStateEnvelope(snapshot, world, parameters) {
  let parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : cloneJson(snapshot);
  if (parsed?.snapshotSchemaVersion === 1) parsed = migrateSnapshotV1(parsed, world, parameters);
  if (parsed?.snapshotSchemaVersion === 2) parsed = migrateSnapshotV2(parsed, world, parameters);
  const state = parsed?.snapshotSchemaVersion === SNAPSHOT_SCHEMA_VERSION ? parsed.state : parsed;
  const restored = cloneJson(state);
  validateState(restored, world, parameters);
  return restored;
}

export function migrateSnapshotV1(snapshot, world, parameters = PROPOSED_SYNTHETIC_PARAMETERS_V1) {
  if (snapshot?.snapshotSchemaVersion !== 1 || !snapshot.state) {
    throw new RangeError("Only reference snapshot schema 1 can migrate to the current schema.");
  }
  const legacy = cloneJson(snapshot.state);
  const state = createReferenceState({
    world,
    parameters,
    masterSeed: legacy.masterSeed,
    initialRp: legacy.rp?.balance ?? 0,
  });
  state.clock = cloneJson(legacy.clock ?? state.clock);
  state.random = cloneJson(legacy.random ?? state.random);
  state.livingTrees = cloneJson(legacy.livingTrees ?? []);
  state.recruits = cloneJson(legacy.recruits ?? []);
  state.propagules = cloneJson(legacy.propagules ?? []);
  state.cohorts = cloneJson(legacy.cohorts ?? []);
  state.snags = cloneJson(legacy.snags ?? []);
  state.deadwood = cloneJson(legacy.deadwood ?? []);
  state.events = cloneJson(legacy.events ?? []).slice(-parameters.bounds.retainedEvents);
  state.history = cloneJson(legacy.history ?? []).slice(-parameters.bounds.retainedHistory);
  state.counters = { ...state.counters, ...(legacy.counters ?? {}) };
  state.nextIds = deriveNextIds(state);
  normalizeSpatialRecords(state, world);
  updateCanopyLight(state, world, parameters);
  updateSourceContinuity(state);
  validateState(state, world, parameters);
  return {
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kernelContractVersion: KERNEL_CONTRACT_VERSION,
    parameterSetId: parameters.parameterSetId,
    worldId: world.worldId,
    reason: "migrated-from-reference-schema-1",
    migration: { from: 1, to: SNAPSHOT_SCHEMA_VERSION, randomDrawsConsumed: 0, inventedSeedCount: 0 },
    state,
  };
}

export function migrateSnapshotV2(snapshot, world, parameters = PROPOSED_SYNTHETIC_PARAMETERS_V1) {
  if (snapshot?.snapshotSchemaVersion !== 2 || !snapshot.state) {
    throw new RangeError("Only reference snapshot schema 2 can migrate to schema 3.");
  }
  const state = cloneJson(snapshot.state);
  state.stateSchemaVersion = STATE_SCHEMA_VERSION;
  state.ruleVersion = KERNEL_CONTRACT_VERSION;
  normalizeSpatialRecords(state, world);
  updateCanopyLight(state, world, parameters);
  updateSourceContinuity(state);
  validateState(state, world, parameters);
  return {
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kernelContractVersion: KERNEL_CONTRACT_VERSION,
    parameterSetId: parameters.parameterSetId,
    worldId: world.worldId,
    reason: "migrated-from-reference-schema-2",
    migration: { from: 2, to: 3, randomDrawsConsumed: 0, inventedSeedCount: 0 },
    state,
  };
}

export function validateState(state, world, parameters = PROPOSED_SYNTHETIC_PARAMETERS_V1) {
  assertParameterSet(parameters);
  assertJsonValue(state, "state");
  if (state.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new RangeError("Unsupported state schema.");
  if (state.ruleVersion !== KERNEL_CONTRACT_VERSION) throw new RangeError("Rule version mismatch.");
  if (state.parameterSetId !== parameters.parameterSetId) throw new RangeError("Parameter-set mismatch.");
  if (state.worldId !== world.worldId) throw new RangeError("World identity mismatch.");
  validateRandomLedger(state.random);
  for (const [store, cap] of [
    ["livingTrees", parameters.bounds.individuals],
    ["recruits", parameters.bounds.recruits],
    ["propagules", parameters.bounds.propaguleBins],
    ["cohorts", parameters.bounds.cohorts],
    ["snags", parameters.bounds.snags],
    ["deadwood", parameters.bounds.deadwoodPools],
    ["events", parameters.bounds.retainedEvents],
    ["history", parameters.bounds.retainedHistory],
    ["processedCommands", parameters.bounds.processedCommands],
  ]) {
    if (!Array.isArray(state[store]) || state[store].length > cap) {
      throw new RangeError(`${store} exceeds its independent bound.`);
    }
  }
  if (!Array.isArray(state.pendingCommands) || state.pendingCommands.length > parameters.bounds.processedCommands) {
    throw new RangeError("pendingCommands exceeds its bound.");
  }
  if (
    state.clock.protectedOfflineDays !== undefined &&
    (!Number.isSafeInteger(state.clock.protectedOfflineDays) || state.clock.protectedOfflineDays < 0)
  ) throw new RangeError("clock.protectedOfflineDays must be a nonnegative integer when present.");
  const entityIds = new Set();
  for (const record of [
    ...state.livingTrees,
    ...state.recruits,
    ...state.propagules,
    ...state.cohorts,
    ...state.snags,
    ...state.deadwood,
  ]) {
    if (typeof record.id !== "string" || entityIds.has(record.id)) {
      throw new RangeError("Ecological entity IDs must be unique strings.");
    }
    entityIds.add(record.id);
    if (!world.cells.some((cell) => cell.cellId === record.cellId)) {
      throw new RangeError(`Record ${record.id} references an unknown cell.`);
    }
    if (!MANAGEMENT_CLASSES.has(record.managementClass)) {
      throw new RangeError(`Record ${record.id} has an invalid management class.`);
    }
    validatePosition(record.position, `${record.id}.position`);
    if (
      record.offlineAgeDays !== undefined &&
      (!Number.isSafeInteger(record.offlineAgeDays) || record.offlineAgeDays < 0)
    ) throw new RangeError(`${record.id}.offlineAgeDays must be a nonnegative integer when present.`);
  }
  for (const cell of world.cells) {
    if (representedGrowingSpaceAtCell(state, cell.cellId) > cellCapacity(cell, parameters)) {
      throw new RangeError(`Growing-space capacity exceeded in ${cell.cellId}.`);
    }
  }
  if (state.counters.inventedSeedCount !== 0) throw new RangeError("Invented seed is prohibited.");
  if (state.rp.balance < 0 || state.rp.cumulativeEarned < 0 || state.rp.cumulativeSpent < 0) {
    throw new RangeError("RP values must be nonnegative.");
  }
  return true;
}

function validateWorld(world) {
  assertJsonValue(world, "world");
  if (world.worldSchemaVersion !== 1) throw new RangeError("Unsupported world schema.");
  if (world.scaleLabel !== "synthetic-unitless-stand") throw new RangeError("World scale must remain truthful.");
  if (world.crsStatus !== "open") throw new RangeError("Reference world must not settle the CRS.");
  if (!Array.isArray(world.cells) || world.cells.length < 1) throw new TypeError("World cells are required.");
  if (Object.hasOwn(world, "minimumSupportRadius") && (!(world.minimumSupportRadius > 0) || !Number.isFinite(world.minimumSupportRadius))) {
    throw new RangeError("World minimumSupportRadius must be finite and positive when supplied.");
  }
  const ids = new Set();
  for (const cell of world.cells) {
    if (typeof cell.cellId !== "string" || ids.has(cell.cellId)) throw new RangeError("World cell IDs must be unique.");
    ids.add(cell.cellId);
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) {
      throw new RangeError(`${cell.cellId} requires finite stand-local coordinates.`);
    }
    for (const key of ["siteLight01", "suitability01"]) {
      if (!Number.isFinite(cell[key]) || cell[key] < 0 || cell[key] > 1) {
        throw new RangeError(`${cell.cellId}.${key} must be within [0,1].`);
      }
    }
    if (!Number.isSafeInteger(cell.growingSpaceStems) || cell.growingSpaceStems < 1) {
      throw new RangeError(`${cell.cellId}.growingSpaceStems must be a positive integer.`);
    }
  }
}

function validateAndCloneCommand(raw) {
  const command = cloneJson(raw);
  assertJsonValue(command, "command");
  if (command.commandSchemaVersion !== COMMAND_SCHEMA_VERSION) throw new RangeError("Unsupported command schema.");
  for (const key of ["commandId", "idempotencyKey", "source", "type"]) {
    if (typeof command[key] !== "string" || !command[key]) throw new TypeError(`command.${key} is required.`);
  }
  if (!COMMAND_TYPES.has(command.type)) throw new RangeError(`Unsupported command type: ${command.type}`);
  if (!Number.isSafeInteger(command.targetStep) || command.targetStep < 0) throw new TypeError("command.targetStep is invalid.");
  if (!Number.isSafeInteger(command.issuedSequence) || command.issuedSequence < 0) throw new TypeError("command.issuedSequence is invalid.");
  if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    throw new TypeError("command.payload must be an object.");
  }
  return command;
}

function compareCommands(left, right) {
  return (
    left.targetStep - right.targetStep ||
    left.issuedSequence - right.issuedSequence ||
    compareUtf8(left.commandId, right.commandId)
  );
}

function recordProcessedCommand(state, command, result) {
  const existing = state.processedCommands.find((entry) => entry.commandId === command.commandId);
  if (existing?.result.status === "accepted-pending" && result.status !== "accepted-pending") {
    existing.result = cloneJson(result);
    return;
  }
  if (!existing) {
    state.processedCommands.push({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      targetStep: command.targetStep,
      issuedSequence: command.issuedSequence,
      type: command.type,
      result: cloneJson(result),
    });
    state.processedCommands.sort(
      (left, right) => left.issuedSequence - right.issuedSequence || compareUtf8(left.commandId, right.commandId),
    );
  }
}

function compactProcessedCommands(state, parameters, requiredSlots) {
  const pendingIds = new Set(state.pendingCommands.map((command) => command.commandId));
  let removed = 0;
  state.processedCommands = state.processedCommands.filter((entry) => {
    const mustRemove =
      removed < requiredSlots &&
      entry.result.status !== "accepted-pending" &&
      !pendingIds.has(entry.commandId);
    if (mustRemove) removed += 1;
    return !mustRemove;
  });
  state.instrumentation.compactions.processedCommands += removed;
  if (state.processedCommands.length > parameters.bounds.processedCommands) {
    throw new RangeError("Processed command compaction failed to preserve its bound.");
  }
}

function acceptedCommand(state, command, minted) {
  return {
    status: "accepted",
    resultId: allocateId(state, "result"),
    commandId: command.commandId,
    reasonCode: null,
    directSeedCreated: 1,
    directRpAwarded: 0,
    minted,
  };
}

function rejectedCommand(reasonCode) {
  return {
    status: "rejected",
    resultId: null,
    reasonCode,
    directSeedCreated: 0,
    directRpAwarded: 0,
    minted: {},
  };
}

function createPropagule(state, input) {
  return {
    id: allocateId(state, "seed"),
    speciesId: input.speciesId,
    managementClass: input.managementClass,
    cellId: input.cellId,
    position: clonePosition(input.position),
    seedCount: input.seedCount,
    germinatedCount: 0,
    ageSteps: 0,
    sourceKind: input.sourceKind,
    sourceEntityId: input.sourceEntityId,
    provenance: input.provenance,
    causeCommandId: input.causeCommandId,
    featuredOnPromotion: input.featuredOnPromotion,
    individualOnPromotion: input.individualOnPromotion,
  };
}

function displacedLanding(state, world, parameters, source, direction, command) {
  const pulseIndex = command.payload.pulseIndex ?? 0;
  const distanceDraw = drawUnit(state, "dispersal", command.commandId, pulseIndex, "distance");
  const angleDraw = drawUnit(state, "dispersal", command.commandId, pulseIndex, "angle");
  const distance = parameters.propagule.directDispersalCore +
    parameters.propagule.directDispersalTail * distanceDraw;
  const angleOffset = (angleDraw - 0.5) * Math.PI * 0.24;
  const cos = Math.cos(angleOffset);
  const sin = Math.sin(angleOffset);
  const spreadDirection = {
    x: direction.x * cos - direction.y * sin,
    y: direction.x * sin + direction.y * cos,
  };
  const origin = source.position ?? positionAtCell(requireCell(world, source.cellId));
  return boundedLanding(world, {
    frame: SPATIAL_POSITION_FRAME,
    x: origin.x + spreadDirection.x * distance,
    y: origin.y + spreadDirection.y * distance,
  });
}

function naturalLanding(state, world, parameters, source) {
  const angle = drawUnit(state, "dispersal", source.id, state.clock.step, "natural-angle") * Math.PI * 2;
  const distanceDraw = drawUnit(state, "dispersal", source.id, state.clock.step, "natural-distance");
  const distance = parameters.propagule.directDispersalCore * 0.35 +
    parameters.propagule.directDispersalTail * 0.65 * distanceDraw;
  const origin = source.position ?? positionAtCell(requireCell(world, source.cellId));
  return boundedLanding(world, {
    frame: SPATIAL_POSITION_FRAME,
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
  });
}

function boundedLanding(world, rawPosition) {
  const cell = nearestCell(world, rawPosition);
  const radius = supportRadius(world, cell);
  const dx = rawPosition.x - cell.x;
  const dy = rawPosition.y - cell.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius || distance === 0) {
    return { cell, position: normalizedPosition(rawPosition) };
  }
  const scale = radius / distance;
  return {
    cell,
    position: normalizedPosition({
      frame: SPATIAL_POSITION_FRAME,
      x: cell.x + dx * scale,
      y: cell.y + dy * scale,
    }),
  };
}

export function sampleSiteAtPosition(world, state, rawPosition) {
  const position = normalizedPosition(rawPosition);
  const exact = world.cells.find(
    (cell) => Math.abs(cell.x - position.x) <= 1e-12 && Math.abs(cell.y - position.y) <= 1e-12,
  );
  if (exact) {
    const dynamic = state?.cellState?.find(({ cellId }) => cellId === exact.cellId);
    return {
      contract: SITE_INTERPOLATION_CONTRACT,
      position,
      bookkeepingCellId: exact.cellId,
      suitability01: exact.suitability01,
      siteLight01: exact.siteLight01,
      availableLight01: dynamic?.availableLight01 ?? exact.siteLight01,
    };
  }
  let weightTotal = 0;
  let suitability = 0;
  let siteLight = 0;
  let availableLight = 0;
  for (const cell of world.cells) {
    const distanceSquared = (cell.x - position.x) ** 2 + (cell.y - position.y) ** 2;
    const weight = 1 / Math.max(1e-12, distanceSquared);
    const dynamic = state?.cellState?.find(({ cellId }) => cellId === cell.cellId);
    weightTotal += weight;
    suitability += cell.suitability01 * weight;
    siteLight += cell.siteLight01 * weight;
    availableLight += (dynamic?.availableLight01 ?? cell.siteLight01) * weight;
  }
  return {
    contract: SITE_INTERPOLATION_CONTRACT,
    position,
    bookkeepingCellId: nearestCell(world, position).cellId,
    suitability01: quantize(suitability / weightTotal),
    siteLight01: quantize(siteLight / weightTotal),
    availableLight01: quantize(availableLight / weightTotal),
  };
}

function nearestCell(world, position) {
  return [...world.cells].sort((left, right) => {
    const leftDistance = (left.x - position.x) ** 2 + (left.y - position.y) ** 2;
    const rightDistance = (right.x - position.x) ** 2 + (right.y - position.y) ** 2;
    return leftDistance - rightDistance || compareUtf8(left.cellId, right.cellId);
  })[0];
}

function supportRadius(world, cell) {
  const neighbors = world.cells
    .filter((candidate) => candidate.cellId !== cell.cellId)
    .map((candidate) => Math.hypot(candidate.x - cell.x, candidate.y - cell.y))
    .filter((distance) => distance > 1e-12)
    .sort((left, right) => left - right);
  const sampledRadius = neighbors.length > 0 ? neighbors[0] * 0.56 : 4;
  return Math.max(sampledRadius, world.minimumSupportRadius ?? 0);
}

function normalizeSpatialRecords(state, world) {
  for (const store of ["livingTrees", "recruits", "propagules", "cohorts", "snags", "deadwood"]) {
    for (const record of state[store]) {
      if (record.position) {
        record.position = normalizedPosition(record.position);
        continue;
      }
      const cell = requireCell(world, record.cellId);
      const centered = record.founder === true || record.sourceKind === "explicit-founder-provenance";
      record.position = centered
        ? positionAtCell(cell)
        : stableWithinCellPosition(world, cell, `${store}:${record.id}`);
    }
  }
  for (const record of [...state.recruits, ...state.propagules]) {
    if (record.individualOnPromotion === undefined) {
      record.individualOnPromotion = record.featuredOnPromotion === true;
    }
  }
}

function stableWithinCellPosition(world, cell, key) {
  const hash = stableTextHash32(key);
  const angle = (hash / 0x1_0000_0000) * Math.PI * 2;
  const radius = supportRadius(world, cell) * (0.18 + ((hash >>> 16) / 0x1_0000) * 0.22);
  return normalizedPosition({
    frame: SPATIAL_POSITION_FRAME,
    x: cell.x + Math.cos(angle) * radius,
    y: cell.y + Math.sin(angle) * radius,
  });
}

function stableTextHash32(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(text))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function positionAtCell(cell) {
  return normalizedPosition({ frame: SPATIAL_POSITION_FRAME, x: cell.x, y: cell.y });
}

function normalizedPosition(position) {
  validatePosition(position, "position");
  return {
    frame: SPATIAL_POSITION_FRAME,
    x: quantize(position.x),
    y: quantize(position.y),
  };
}

function clonePosition(position) {
  return normalizedPosition(position);
}

function weightedPosition(left, leftCount, right, rightCount) {
  const total = leftCount + rightCount;
  return normalizedPosition({
    frame: SPATIAL_POSITION_FRAME,
    x: (left.x * leftCount + right.x * rightCount) / total,
    y: (left.y * leftCount + right.y * rightCount) / total,
  });
}

function samePosition(left, right) {
  return left?.frame === SPATIAL_POSITION_FRAME &&
    right?.frame === SPATIAL_POSITION_FRAME &&
    left.x === right.x &&
    left.y === right.y;
}

function validatePosition(position, path) {
  if (!position || position.frame !== SPATIAL_POSITION_FRAME) {
    throw new RangeError(`${path} must use ${SPATIAL_POSITION_FRAME}.`);
  }
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new TypeError(`${path} coordinates must be finite.`);
  }
  return true;
}

function validateDirection(direction) {
  if (!direction || direction.frame !== "stand-local-unitless" || direction.unit !== "unit-vector") {
    throw new RangeError("Seed direction must use the stand-local unit-vector frame.");
  }
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y)) throw new TypeError("Direction components must be finite.");
  const magnitude = Math.hypot(direction.x, direction.y);
  if (Math.abs(magnitude - 1) > 1e-6) throw new RangeError("Direction must be normalized.");
  return { x: direction.x / magnitude, y: direction.y / magnitude };
}

function findLivingSource(state, id) {
  const tree = state.livingTrees.find((candidate) => candidate.id === id);
  if (tree) return tree;
  const cohort = state.cohorts.find((candidate) => candidate.id === id);
  if (!cohort) return null;
  return { ...cohort, reproductive: cohort.reproductiveStemCount > 0 };
}

function installInitialRecords(state, initial) {
  for (const store of ["livingTrees", "recruits", "propagules", "cohorts", "snags", "deadwood"]) {
    if (initial[store]) state[store] = cloneJson(initial[store]);
  }
  if (initial.rp) state.rp = { ...state.rp, ...cloneJson(initial.rp) };
  state.nextIds = deriveNextIds(state);
}

function deriveNextIds(state) {
  const ids = [
    ...state.livingTrees,
    ...state.recruits,
    ...state.propagules,
    ...state.cohorts,
    ...state.snags,
    ...state.deadwood,
  ].map((record) => numericSuffix(record.id));
  const eventIds = state.events.map((event) => numericSuffix(event.eventId));
  const historyIds = state.history.map((item) => numericSuffix(item.historyId));
  return {
    entity: Math.max(0, ...ids) + 1,
    event: Math.max(0, ...eventIds) + 1,
    result: 1,
    history: Math.max(0, ...historyIds) + 1,
  };
}

function allocateId(state, prefix) {
  const id = `${prefix}-${state.nextIds.entity}`;
  state.nextIds.entity += 1;
  return id;
}

function normalizeAdvanceSteps(request) {
  const steps = typeof request === "number" ? request : request?.steps;
  if (!Number.isSafeInteger(steps) || steps < 0 || steps > 10_000) {
    throw new RangeError("advance requires 0..10000 explicit integer steps.");
  }
  return steps;
}

function normalizeProtectedOfflineDays(request) {
  if (request?.policyVersion !== PROTECTED_OFFLINE_POLICY_VERSION) {
    throw new RangeError("Protected offline policy version mismatch.");
  }
  const elapsedDays = request?.elapsedDays;
  if (!Number.isSafeInteger(elapsedDays) || elapsedDays < 0 || elapsedDays > PROTECTED_OFFLINE_MAX_DAYS) {
    throw new RangeError(`protected offline elapsedDays requires 0..${PROTECTED_OFFLINE_MAX_DAYS}.`);
  }
  return elapsedDays;
}

function representedGrowingSpaceAtCell(state, cellId) {
  return (
    state.livingTrees.filter((tree) => tree.cellId === cellId).length +
    state.cohorts.filter((cohort) => cohort.cellId === cellId).reduce((sum, cohort) => sum + cohort.stemCount, 0) +
    state.recruits.filter((recruit) => recruit.cellId === cellId).reduce((sum, recruit) => sum + recruit.stemCount, 0)
  );
}

function cellCapacity(cell, parameters) {
  return Math.min(cell.growingSpaceStems, parameters.bounds.representedLivingStemsPerCell);
}

function canopyForCohort(cohort, parameters) {
  const coefficient =
    cohort.stage === "mature"
      ? parameters.cohort.canopyPerMatureStem01
      : cohort.stage === "senescent"
        ? parameters.cohort.canopyPerSenescentStem01
        : parameters.cohort.canopyPerJuvenileStem01;
  return quantize(Math.min(0.94, cohort.stemCount * coefficient * Math.max(0.1, cohort.meanSize01)));
}

function stageForAge(ageSteps, parameters) {
  if (ageSteps >= parameters.tree.senescenceAgeSteps) return "senescent";
  if (ageSteps >= parameters.tree.maturityAgeSteps) return "mature";
  return "juvenile";
}

function effectiveAgeYears(record) {
  return Number(record.ageSteps ?? 0) + Number(record.offlineAgeDays ?? 0) / DAYS_PER_SYNTHETIC_YEAR;
}

function mortalityForStage(stage, rules) {
  if (stage === "senescent") return rules.senescentMortality01;
  if (stage === "mature") return rules.matureMortality01;
  return rules.juvenileMortality01;
}

function requireCell(world, cellId) {
  const cell = world.cells.find((candidate) => candidate.cellId === cellId);
  if (!cell) throw new RangeError(`Unknown world cell: ${cellId}`);
  return cell;
}

function requireCellState(state, cellId) {
  const cell = state.cellState.find((candidate) => candidate.cellId === cellId);
  if (!cell) throw new RangeError(`Unknown dynamic cell: ${cellId}`);
  return cell;
}

function work(state, units) {
  state.instrumentation.workUnitsLastStep += units;
}

function byId(left, right) {
  return compareUtf8(left.id, right.id);
}

function numericSuffix(value) {
  const match = String(value ?? "").match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}
