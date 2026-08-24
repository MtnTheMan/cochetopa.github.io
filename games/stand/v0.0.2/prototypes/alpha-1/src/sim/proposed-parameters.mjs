export const PROPOSED_SYNTHETIC_PARAMETERS_V1 = deepFreeze({
  parameterSetId: "stand-sugar-maple-synthetic-reference@1",
  schemaVersion: 1,
  decisionStatus: "working-fixture-only-not-production-tuning",
  scaleLabel: "synthetic-unitless-stand",
  speciesId: "acer-saccharum",
  cadence: {
    unit: "synthetic-reference-year",
    yearsPerStep: 1,
    productionCadenceSelected: false,
  },
  warnings: [
    "Every numeric value is a proposed executable fixture input, not a Oneida observation or calibrated production value.",
    "Suitability is a relative site factor and is not a survival probability.",
    "The stand-local coordinate frame is unitless and does not settle CRS, grid, lattice, or dispersal distance units.",
  ],
  bounds: {
    activeCells: 16,
    individuals: 96,
    recruits: 64,
    propaguleBins: 64,
    cohorts: 48,
    snags: 32,
    deadwoodPools: 32,
    retainedEvents: 128,
    retainedHistory: 32,
    processedCommands: 256,
    representedLivingStemsPerCell: 480,
  },
  propagule: {
    germinationAgeSteps: 1,
    resolutionAgeSteps: 2,
    maximumAgeSteps: 3,
    baseGermination01: 0.8,
    baseEstablishment01: 0.6,
    seedCostRp: 1,
    directDispersalCore: 1.75,
    directDispersalTail: 3.25,
    naturalSeedsPerReproductiveStem: 0.3,
    maximumNaturalSeedsPerSourcePerStep: 120,
  },
  recruit: {
    persistenceAgeSteps: 3,
    promotionDevelopment01: 1,
    baseAnnualSurvival01: 0.995,
    suppressedAnnualSurvival01: 0.985,
    suppressedLightAtOrBelow01: 0.18,
    releaseLightAtOrAbove01: 0.34,
    suppressedGrowthPerStep01: 0.05,
    openGrowthPerStep01: 0.22,
    releaseProgressPerStep01: 0.25,
  },
  tree: {
    maturityAgeSteps: 20,
    senescenceAgeSteps: 70,
    maximumAgeSteps: 105,
    baseGrowthPerStep01: 0.025,
    juvenileMortality01: 0.006,
    matureMortality01: 0.018,
    senescentMortality01: 0.075,
    nurtureGrowthAdvance01: 0.08,
    canopyPerIndividualAtFullSize01: 0.012,
  },
  cohort: {
    juvenileMortality01: 0.006,
    matureMortality01: 0.01,
    senescentMortality01: 0.045,
    canopyPerJuvenileStem01: 0.0012,
    canopyPerMatureStem01: 0.0022,
    canopyPerSenescentStem01: 0.0017,
    ambientRecruitmentPerStep: 2,
  },
  deadMatter: {
    snagResidenceSteps: 4,
    deadwoodResidenceSteps: 8,
  },
  light: {
    maximumLivingCanopyPressure01: 0.94,
  },
  rewards: {
    recruitPersistenceRp: 1,
    individualMaturityRp: 2,
    cohortMaturityRpPerBatch: 2,
  },
  numeric: {
    continuousQuantum: 1e-9,
    conservationTolerance: 1e-9,
  },
});

export function assertParameterSet(parameters) {
  if (!parameters || parameters.parameterSetId !== PROPOSED_SYNTHETIC_PARAMETERS_V1.parameterSetId) {
    throw new RangeError("Unsupported ecological parameter set.");
  }
  if (parameters.decisionStatus !== "working-fixture-only-not-production-tuning") {
    throw new RangeError("Reference parameters must retain their Working fixture-only status.");
  }
  if (parameters.scaleLabel !== "synthetic-unitless-stand") {
    throw new RangeError("Reference parameters must retain truthful synthetic stand scale.");
  }
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
