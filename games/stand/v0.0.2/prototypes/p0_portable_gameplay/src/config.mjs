export const CONTROLLED_SPECIES_ID = "acer-saccharum";

export const FIXTURE_CONFIG = Object.freeze({
  pulseCadenceMs: 260,
  touchPrecommitMs: 100,
  touchServiceToleranceMs: 16,
  acceptedPulseCap: 24,
  mouseDragThresholdPx: 8,
  touchDragThresholdPx: 12,
  rpBatchWindowMs: 1000,
  rpBatchSettleMs: 600,
  feedCoalesceMs: 2000,
  feedVisibleCap: 4,
  feedRetainedCap: 12,
  ordinaryFeedDwellMs: 10000,
  failureFeedDwellMs: 15000,
  offlineReplayMs: 25000,
  timeSpeeds: [1, 4, 16],
});

export const TRUTHFUL_COPY = Object.freeze({
  scaleLabel: "Stand view",
  sourceLabel: "Oneida County package • Daymet 1991–2020 normals",
  scopeNote:
    "This is a stand-scale simulation. Oneida County is the v0.0.2 packaging and test boundary, not a county-wide simulation.",
  climateNote:
    "Climate uses 1991–2020 normals at about 1 km effective support. It does not provide wind.",
});

export const PERSISTED_UI_CONTRACT = "STAND-UI-PREFERENCES@1";
