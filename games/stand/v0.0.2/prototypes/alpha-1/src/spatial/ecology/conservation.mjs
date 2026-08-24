import { compareUtf8, quantize } from "../../domain/canonical.mjs";

export const CONSERVATION_CONTRACT = "stand-ecology-conservation@1";

export function conservationSummary(state, filter = {}) {
  const matches = (record) =>
    (!filter.cellId || record.cellId === filter.cellId) &&
    (!filter.managementClass || record.managementClass === filter.managementClass) &&
    (!filter.speciesId || record.speciesId === filter.speciesId);

  const individuals = state.livingTrees.filter(matches);
  const cohorts = state.cohorts.filter(matches);
  const recruits = state.recruits.filter(matches);
  const propagules = state.propagules.filter(matches);
  return {
    livingStemCount:
      individuals.length + cohorts.reduce((sum, cohort) => sum + cohort.stemCount, 0),
    recruitStemCount: recruits.reduce((sum, recruit) => sum + recruit.stemCount, 0),
    propaguleCount: propagules.reduce((sum, bin) => sum + bin.seedCount, 0),
    reproductiveStemCount:
      individuals.reduce((sum, tree) => sum + (tree.reproductive ? 1 : 0), 0) +
      cohorts.reduce((sum, cohort) => sum + cohort.reproductiveStemCount, 0),
    canopyPressure01: quantize(
      individuals.reduce((sum, tree) => sum + tree.canopyPressure01, 0) +
        cohorts.reduce((sum, cohort) => sum + cohort.canopyPressure01, 0),
    ),
    ageMomentStemYears: quantize(
      individuals.reduce((sum, tree) => sum + tree.ageSteps, 0) +
        cohorts.reduce((sum, cohort) => sum + cohort.meanAgeSteps * cohort.stemCount, 0),
    ),
    sizeMoment: quantize(
      individuals.reduce((sum, tree) => sum + tree.size01, 0) +
        cohorts.reduce((sum, cohort) => sum + cohort.meanSize01 * cohort.stemCount, 0),
    ),
  };
}

export function aggregateIndividuals(state, request, parameters) {
  const cellId = requiredString(request.cellId, "aggregate.cellId");
  const managementClass = requiredString(
    request.managementClass,
    "aggregate.managementClass",
  );
  const speciesId = request.speciesId ?? parameters.speciesId;
  const retainedIds = new Set(request.retainEntityIds ?? []);
  const selected = state.livingTrees
    .filter(
      (tree) =>
        tree.cellId === cellId &&
        tree.managementClass === managementClass &&
        tree.speciesId === speciesId &&
        !retainedIds.has(tree.id) &&
        !tree.featured,
    )
    .sort((left, right) => compareUtf8(left.id, right.id));

  const before = conservationSummary(state, { cellId, managementClass, speciesId });
  if (selected.length === 0) {
    return { changed: false, before, after: before, aggregatedIndividualIds: [] };
  }

  const groups = new Map();
  for (const tree of selected) {
    const key = [tree.stage, tree.provenance].join("|");
    const group = groups.get(key) ?? [];
    group.push(tree);
    groups.set(key, group);
  }

  const selectedIds = new Set(selected.map((tree) => tree.id));
  state.livingTrees = state.livingTrees.filter((tree) => !selectedIds.has(tree.id));

  for (const group of groups.values()) {
    const first = group[0];
    const stemCount = group.length;
    const cohort = {
      id: allocateId(state, "cohort"),
      speciesId,
      managementClass,
      cellId,
      position: meanPosition(group),
      stage: first.stage,
      stemCount,
      meanAgeSteps: quantize(group.reduce((sum, tree) => sum + tree.ageSteps, 0) / stemCount),
      meanSize01: quantize(group.reduce((sum, tree) => sum + tree.size01, 0) / stemCount),
      canopyPressure01: quantize(
        group.reduce((sum, tree) => sum + tree.canopyPressure01, 0),
      ),
      reproductiveStemCount: group.reduce(
        (sum, tree) => sum + (tree.reproductive ? 1 : 0),
        0,
      ),
      provenance: first.provenance,
      maturityRewarded: group.every((tree) => tree.maturityRewarded),
    };
    state.cohorts.push(cohort);
  }

  coalesceCompatibleCohorts(state, parameters);
  state.instrumentation.compactions.cohorts += selected.length;
  const after = conservationSummary(state, { cellId, managementClass, speciesId });
  assertConserved(before, after, parameters.numeric.conservationTolerance);
  return {
    changed: true,
    before,
    after,
    aggregatedIndividualIds: [...selectedIds].sort(compareUtf8),
  };
}

export function refineCohort(state, request, parameters, drawUnit) {
  const cohortId = requiredString(request.cohortId, "refine.cohortId");
  const cohort = state.cohorts.find((candidate) => candidate.id === cohortId);
  if (!cohort) throw new RangeError(`Unknown cohort: ${cohortId}`);
  const requested = Math.max(0, Math.trunc(request.stemCount ?? 1));
  const availableSlots = parameters.bounds.individuals - state.livingTrees.length;
  const refinedCount = Math.min(requested, cohort.stemCount, availableSlots);
  const filter = {
    cellId: cohort.cellId,
    managementClass: cohort.managementClass,
    speciesId: cohort.speciesId,
  };
  const before = conservationSummary(state, filter);
  if (refinedCount === 0) {
    return { changed: false, refinedCount: 0, before, after: before, individualIds: [] };
  }

  const perStemCanopy = cohort.canopyPressure01 / cohort.stemCount;
  const reproductiveRatio = cohort.reproductiveStemCount / cohort.stemCount;
  const individualIds = [];
  let reproductiveRefined = 0;
  for (let index = 0; index < refinedCount; index += 1) {
    const id = allocateId(state, "tree");
    const reproductive = drawUnit(
      state,
      "refinement",
      cohort.id,
      state.clock.step,
      index,
    ) < reproductiveRatio;
    const angle = drawUnit(
      state,
      "refinement",
      cohort.id,
      state.clock.step,
      index,
      "position-angle",
    ) * Math.PI * 2;
    const radius = 0.04 + drawUnit(
      state,
      "refinement",
      cohort.id,
      state.clock.step,
      index,
      "position-radius",
    ) * 0.12;
    reproductiveRefined += reproductive ? 1 : 0;
    state.livingTrees.push({
      id,
      speciesId: cohort.speciesId,
      managementClass: cohort.managementClass,
      cellId: cohort.cellId,
      position: {
        frame: cohort.position.frame,
        x: quantize(cohort.position.x + Math.cos(angle) * radius),
        y: quantize(cohort.position.y + Math.sin(angle) * radius),
      },
      stage: cohort.stage,
      ageSteps: cohort.meanAgeSteps,
      development01: cohort.meanSize01,
      size01: cohort.meanSize01,
      canopyPressure01: quantize(perStemCanopy),
      reproductive,
      provenance: cohort.provenance,
      featured: false,
      founder: false,
      maturityRewarded: cohort.maturityRewarded,
      nurturePending01: 0,
    });
    individualIds.push(id);
  }

  cohort.stemCount -= refinedCount;
  cohort.reproductiveStemCount -= reproductiveRefined;
  cohort.canopyPressure01 = quantize(cohort.canopyPressure01 - perStemCanopy * refinedCount);
  if (cohort.stemCount === 0) {
    state.cohorts = state.cohorts.filter((candidate) => candidate.id !== cohort.id);
  }
  const after = conservationSummary(state, filter);
  assertConserved(before, after, parameters.numeric.conservationTolerance);
  return { changed: true, refinedCount, before, after, individualIds };
}

export function coalesceCompatibleCohorts(state, parameters) {
  const ordered = [...state.cohorts].sort((left, right) => compareUtf8(left.id, right.id));
  const groups = new Map();
  for (const cohort of ordered) {
    const key = [
      cohort.speciesId,
      cohort.managementClass,
      cohort.cellId,
      cohort.stage,
      cohort.provenance,
      cohort.maturityRewarded ? "rewarded" : "unrewarded",
    ].join("|");
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, cohort);
      continue;
    }
    mergeCohorts(existing, cohort);
    state.cohorts = state.cohorts.filter((candidate) => candidate.id !== cohort.id);
    state.instrumentation.compactions.cohorts += 1;
  }
  while (state.cohorts.length > parameters.bounds.cohorts) {
    const candidates = [...state.cohorts].sort((left, right) => {
      const leftKey = `${left.speciesId}|${left.managementClass}|${left.cellId}|${left.meanAgeSteps}`;
      const rightKey = `${right.speciesId}|${right.managementClass}|${right.cellId}|${right.meanAgeSteps}`;
      return compareUtf8(leftKey, rightKey);
    });
    let pair = null;
    for (let index = 1; index < candidates.length; index += 1) {
      if (
        candidates[index - 1].speciesId === candidates[index].speciesId &&
        candidates[index - 1].managementClass === candidates[index].managementClass &&
        candidates[index - 1].cellId === candidates[index].cellId
      ) {
        pair = [candidates[index - 1], candidates[index]];
        break;
      }
    }
    if (!pair) throw new RangeError("Cohort cap cannot be satisfied without crossing identity boundaries.");
    mergeCohorts(pair[0], pair[1]);
    state.cohorts = state.cohorts.filter((candidate) => candidate.id !== pair[1].id);
    state.instrumentation.compactions.cohorts += 1;
  }
}

export function assertConserved(before, after, tolerance = 1e-9) {
  for (const key of [
    "livingStemCount",
    "recruitStemCount",
    "propaguleCount",
    "reproductiveStemCount",
  ]) {
    if (before[key] !== after[key]) {
      throw new RangeError(`Conservation failed for ${key}: ${before[key]} != ${after[key]}`);
    }
  }
  for (const key of ["canopyPressure01", "ageMomentStemYears", "sizeMoment"]) {
    if (Math.abs(before[key] - after[key]) > tolerance) {
      throw new RangeError(`Conservation failed for ${key}: ${before[key]} != ${after[key]}`);
    }
  }
  return true;
}

function mergeCohorts(target, source) {
  const total = target.stemCount + source.stemCount;
  target.position = weightedPosition(
    target.position,
    target.stemCount,
    source.position,
    source.stemCount,
  );
  target.meanAgeSteps = quantize(
    (target.meanAgeSteps * target.stemCount + source.meanAgeSteps * source.stemCount) / total,
  );
  target.meanSize01 = quantize(
    (target.meanSize01 * target.stemCount + source.meanSize01 * source.stemCount) / total,
  );
  target.canopyPressure01 = quantize(target.canopyPressure01 + source.canopyPressure01);
  target.stemCount = total;
  target.reproductiveStemCount += source.reproductiveStemCount;
  target.maturityRewarded = target.maturityRewarded && source.maturityRewarded;
  target.stage = stageForAge(target.meanAgeSteps);
}

function meanPosition(records) {
  const count = records.length;
  return {
    frame: records[0].position.frame,
    x: quantize(records.reduce((sum, record) => sum + record.position.x, 0) / count),
    y: quantize(records.reduce((sum, record) => sum + record.position.y, 0) / count),
  };
}

function weightedPosition(left, leftCount, right, rightCount) {
  const total = leftCount + rightCount;
  return {
    frame: left.frame,
    x: quantize((left.x * leftCount + right.x * rightCount) / total),
    y: quantize((left.y * leftCount + right.y * rightCount) / total),
  };
}

function stageForAge(ageSteps) {
  if (ageSteps >= 70) return "senescent";
  if (ageSteps >= 20) return "mature";
  return "juvenile";
}

function allocateId(state, prefix) {
  const occupied = new Set([
    ...state.livingTrees,
    ...state.recruits,
    ...state.propagules,
    ...state.cohorts,
    ...state.snags,
    ...state.deadwood,
  ].map((record) => record.id));
  let id;
  do {
    id = `${prefix}-${state.nextIds.entity}`;
    state.nextIds.entity += 1;
  } while (occupied.has(id));
  return id;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}
