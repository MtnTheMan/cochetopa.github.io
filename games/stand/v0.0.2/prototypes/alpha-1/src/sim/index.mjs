export {
  AMBIENT_UNKNOWN_ID,
  COMMAND_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  KERNEL_CONTRACT_VERSION,
  PROTECTED_OFFLINE_MAX_DAYS,
  PROTECTED_OFFLINE_POLICY_VERSION,
  SITE_INTERPOLATION_CONTRACT,
  SNAPSHOT_SCHEMA_VERSION,
  SPATIAL_POSITION_FRAME,
  STATE_SCHEMA_VERSION,
  SUGAR_MAPLE_ID,
  ReferenceKernel,
  createKernel,
  createReferenceState,
  createReferenceWorld,
  migrateSnapshotV1,
  migrateSnapshotV2,
  sampleSiteAtPosition,
  validateState,
} from "./reference-kernel.mjs";

export { PROPOSED_SYNTHETIC_PARAMETERS_V1 } from "./proposed-parameters.mjs";
export {
  CONSERVATION_CONTRACT,
  assertConserved,
  conservationSummary,
} from "../spatial/ecology/conservation.mjs";
