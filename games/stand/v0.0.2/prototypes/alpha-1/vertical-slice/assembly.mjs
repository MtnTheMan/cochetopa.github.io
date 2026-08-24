import { canonicalStringify } from "../../../src/spine/canonical-json.mjs";
import { createGameplayController } from "../../p0_portable_gameplay/src/controller.mjs";
import { createGameplayHostAdapter } from "../../p0_portable_gameplay/src/host-adapter.mjs";
import {
  PROTECTED_OFFLINE_MAX_DAYS,
  PROTECTED_OFFLINE_POLICY_VERSION,
} from "../src/sim/index.mjs";
import { createVerticalDomainRuntime } from "./kernel-gameplay-adapter.mjs";
import { createPresentationSnapshot } from "./presentation-adapter.mjs";
import { validateWorldView } from "./world-view.mjs";

export const VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@6";
export const LEGACY_VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@5";
export const OLDER_VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@4";
export const PRIOR_VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@3";
export const EARLIEST_VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@2";
export const ANCIENT_VERTICAL_SAVE_SCHEMA = "stand.vertical-slice-save@1";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createVerticalAssembly(options) {
  const worldView = validateWorldView(options.worldView, { testMode: options.testMode === true });
  const identities = structuredClone(options.identities);
  const storage = options.storage ?? null;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  let domain = createVerticalDomainRuntime({ worldView, masterSeed: options.masterSeed ?? 0x5a17_0002 });
  let revision = 0;
  let pendingTransactions = [];
  const presentationLog = [];
  const seedPresentationBirths = new Map();
  const controller = createGameplayController({
    now,
    idPrefix: options.idPrefix ?? "vertical",
    config: { timeSpeeds: [0.5, 1, 4, 16] },
  });

  const host = createGameplayHostAdapter({
    controller,
    ports: {
      semanticCommands: {
        async submit(command) {
          const result = domain.submitSemantic(command);
          pendingTransactions.push(result.transaction);
          return result.receipt;
        },
      },
      presentation: {
        async attemptSubmitted(intent) { presentationLog.push(structuredClone(intent)); },
        async acceptedSamara(intent) { presentationLog.push(structuredClone(intent)); },
      },
      camera: { async intent(intent) { presentationLog.push(structuredClone(intent)); } },
      time: {
        async setSpeed(speed) { presentationLog.push({ type: "forest-time/speed", speed }); },
        async setPaused(paused) { presentationLog.push({ type: "forest-time/paused", paused }); },
      },
      preferences: { async changed(settings) { presentationLog.push({ type: "preferences", settings }); } },
      lifecycle: { async beforeInputCancellation(reason) { presentationLog.push({ type: "lifecycle/fence", reason }); } },
      world: {
        async create() { pendingTransactions.push(domain.introduceFounder()); },
        async reset() { throw new Error("World reset requires an explicit new-session confirmation in this assembly."); },
      },
      persistence: {
        async save() { return save(); },
        async load() { return load(); },
      },
    },
  });

  async function settle() {
    while (pendingTransactions.length) {
      const transaction = pendingTransactions.shift();
      await host.present(transaction);
      revision += 1;
    }
  }

  async function dispatch(action) {
    const result = await host.dispatch(action);
    await settle();
    return result;
  }

  async function startNew(siteRef = worldView.selectedFounderSiteId) {
    await dispatch({ type: "setup/begin" });
    await dispatch({ type: "setup/site-confirmed", siteRef });
    await dispatch({ type: "setup/founder-landed" });
    return snapshotView();
  }

  async function tick(steps = 1, presentedAt = now()) {
    const transaction = domain.advance(steps);
    transaction.presentedAt = presentedAt;
    await host.present(transaction);
    revision += 1;
    return transaction;
  }

  function saveEnvelope(savedAtUnixMs = wallTimestamp(wallNow())) {
    return {
      schemaVersion: VERTICAL_SAVE_SCHEMA,
      identity: {
        hubCheckpoint: identities.hubCheckpoint,
        foundationReceiptId: identities.foundation.receiptId,
        worldManifestSha256: identities.world.manifestSha256,
        worldSiteStateSha256: identities.world.siteStateSha256,
        kernelCommit: identities.kernel.reviewedCommit,
        gameplayCommit: identities.gameplay.reviewedCommit,
        rendererCommit: identities.renderer.exactIdentityCommit,
      },
      worldView: {
        schemaVersion: worldView.schemaVersion,
        selectedFounderSiteId: worldView.selectedFounderSiteId,
        siteFactorId: worldView.siteFactor.id,
        siteFactorDecisionStatus: worldView.siteFactor.decisionStatus,
      },
      kernelSnapshot: domain.snapshot("vertical-native-save"),
      uiState: controller.serializeUiState(),
      offline: {
        policyVersion: PROTECTED_OFFLINE_POLICY_VERSION,
        savedAtUnixMs,
        appliedThroughUnixMs: savedAtUnixMs,
        activeSimulationRateAtSave: 1,
        curveStatus: "working_1x_only_until_active_rate_curve_is_selected",
      },
    };
  }

  async function save() {
    if (!storage?.save) throw new Error("Foundation native atomic storage port is unavailable.");
    const canonicalPayload = canonicalStringify(saveEnvelope());
    return storage.save(canonicalPayload);
  }

  async function load() {
    if (!storage?.load) throw new Error("Foundation native atomic storage port is unavailable.");
    const stored = await storage.load();
    const candidates = Array.isArray(stored) ? stored : stored ? [stored] : [];
    for (const candidate of candidates) {
      try {
        const observedNow = wallTimestamp(wallNow());
        const envelope = validateSaveEnvelope(JSON.parse(candidate.canonicalPayload), identities, worldView, {
          migrationUnixMs: observedNow,
        });
        domain = createVerticalDomainRuntime({
          worldView,
          masterSeed: options.masterSeed ?? 0x5a17_0002,
          snapshot: envelope.kernelSnapshot,
        });
        controller.restoreUiState(envelope.uiState);
        const plan = planProtectedOffline(envelope.offline, observedNow);
        let offlineDigest = {
          policyVersion: PROTECTED_OFFLINE_POLICY_VERSION,
          status: plan.status,
          elapsedDaysObserved: plan.elapsedDaysObserved,
          elapsedDaysApplied: 0,
          elapsedDaysDiscardedBySafetyCap: plan.elapsedDaysDiscardedBySafetyCap,
          saveGeneration: null,
          harmfulInitiations: 0,
          seriousMortalityTransitions: 0,
          duplicateAwards: 0,
        };
        if (plan.elapsedDaysToApply > 0) {
          const beforeOffline = domain.snapshot("before-protected-offline-transaction");
          const beforeEarned = domain.inspect({ type: "state" }).rp.cumulativeEarned;
          const result = domain.advanceProtectedOffline(plan.elapsedDaysToApply);
          try {
            const canonicalPayload = canonicalStringify(saveEnvelope(observedNow));
            const saveReceipt = await storage.save(canonicalPayload);
            await host.present(result.transaction);
            offlineDigest = {
              ...offlineDigest,
              status: "applied_and_atomically_saved",
              elapsedDaysApplied: plan.elapsedDaysToApply,
              saveGeneration: saveReceipt.generation,
              beforeChecksum: result.digest.beforeChecksum,
              afterChecksum: result.digest.afterChecksum,
              rpEarned: result.digest.rpEarned,
              harmfulInitiations: result.digest.harmfulInitiations,
              seriousMortalityTransitions: result.digest.seriousMortalityTransitions,
              mortalityCountDelta: result.digest.mortalityCountDelta,
              randomDrawsConsumed: result.digest.randomDrawsConsumed,
              pendingCommandsProcessed: result.digest.pendingCommandsProcessed,
              duplicateAwards: Math.max(0, result.digest.rpEarned - (domain.inspect({ type: "state" }).rp.cumulativeEarned - beforeEarned)),
              events: result.digest.events,
            };
          } catch (error) {
            domain = createVerticalDomainRuntime({
              worldView,
              masterSeed: options.masterSeed ?? 0x5a17_0002,
              snapshot: beforeOffline,
            });
            throw error;
          }
        } else {
          const state = domain.inspect({ type: "state" });
          await host.present({
            view: { rpTotal: state.rp.balance, forestStep: state.clock.step, elapsedUs: String(state.clock.step * 1_000_000), localMilestone: null },
            receipts: [],
            events: [],
          });
        }
        revision += 1;
        return { ...candidate, uiState: envelope.uiState, transaction: null, offlineDigest };
      } catch {
        // Foundation retains one known-good prior generation; invalid newest bytes fall back.
      }
    }
    return null;
  }

  function snapshotView() {
    const snapshot = createPresentationSnapshot(domain, worldView, ++revision);
    const observedIds = new Set(snapshot.seeds.map(({ id }) => id));
    for (const id of seedPresentationBirths.keys()) if (!observedIds.has(id)) seedPresentationBirths.delete(id);
    const observedAt = now();
    for (const seed of snapshot.seeds) {
      if (!seedPresentationBirths.has(seed.id)) seedPresentationBirths.set(seed.id, observedAt);
      seed.presentationBornAtMs = seedPresentationBirths.get(seed.id);
    }
    return snapshot;
  }

  return Object.freeze({
    startNew,
    dispatch,
    tick,
    save,
    load,
    saveEnvelope,
    snapshotView,
    checksum: () => domain.checksum(),
    inspect: (request) => domain.inspect(request),
    getGameplayView: () => host.getViewModel(),
    getPresentationLog: () => structuredClone(presentationLog),
    worldView,
  });
}

export function validateSaveEnvelope(envelope, identities, worldView, { migrationUnixMs = null } = {}) {
  let normalized = structuredClone(envelope);
  const sourceSchema = normalized?.schemaVersion;
  const isAncient = sourceSchema === ANCIENT_VERTICAL_SAVE_SCHEMA;
  const isEarliest = sourceSchema === EARLIEST_VERTICAL_SAVE_SCHEMA;
  const isPrior = sourceSchema === PRIOR_VERTICAL_SAVE_SCHEMA;
  const isLegacy = sourceSchema === LEGACY_VERTICAL_SAVE_SCHEMA;
  const isOlder = sourceSchema === OLDER_VERTICAL_SAVE_SCHEMA;
  if (isAncient) {
    const timestamp = wallTimestamp(migrationUnixMs);
    normalized = {
      ...normalized,
      schemaVersion: VERTICAL_SAVE_SCHEMA,
      offline: {
        policyVersion: PROTECTED_OFFLINE_POLICY_VERSION,
        savedAtUnixMs: timestamp,
        appliedThroughUnixMs: timestamp,
        activeSimulationRateAtSave: 1,
        curveStatus: "working_1x_only_until_active_rate_curve_is_selected",
      },
    };
  } else if (isLegacy || isOlder || isPrior || isEarliest) {
    normalized.schemaVersion = VERTICAL_SAVE_SCHEMA;
  }
  if (normalized?.schemaVersion !== VERTICAL_SAVE_SCHEMA) throw new Error("Unsupported vertical save schema.");
  const expected = {
    hubCheckpoint: identities.hubCheckpoint,
    foundationReceiptId: identities.foundation.receiptId,
    worldManifestSha256: identities.world.manifestSha256,
    worldSiteStateSha256: identities.world.siteStateSha256,
    kernelCommit: identities.kernel.reviewedCommit,
    gameplayCommit: identities.gameplay.reviewedCommit,
    rendererCommit: identities.renderer.exactIdentityCommit,
  };
  const expectedIdentity = isAncient
    ? { ...expected, kernelCommit: identities.kernel.ancientReviewedCommit, rendererCommit: identities.renderer.ancientExactIdentityCommit }
    : isEarliest
      ? { ...expected, kernelCommit: identities.kernel.legacyReviewedCommit, rendererCommit: identities.renderer.ancientExactIdentityCommit }
      : isPrior
        ? { ...expected, kernelCommit: identities.kernel.previousReviewedCommit, rendererCommit: identities.renderer.ancientExactIdentityCommit }
        : isOlder
          ? { ...expected, kernelCommit: identities.kernel.previousReviewedCommit, rendererCommit: identities.renderer.legacyExactIdentityCommit }
          : isLegacy
            ? { ...expected, kernelCommit: identities.kernel.previousReviewedCommit, rendererCommit: identities.renderer.previousExactIdentityCommit }
            : expected;
  if (canonicalStringify(normalized.identity) !== canonicalStringify(expectedIdentity)) throw new Error("Vertical save identity mismatch.");
  normalized.identity = expected;
  if (
    normalized.worldView?.selectedFounderSiteId !== worldView.selectedFounderSiteId ||
    normalized.worldView?.siteFactorId !== worldView.siteFactor.id ||
    normalized.worldView?.siteFactorDecisionStatus !== "Working_reversible_not_MaxEnt_or_calibration"
  ) throw new Error("Vertical save World adapter identity mismatch.");
  validateOfflineEnvelope(normalized.offline);
  return normalized;
}

export function planProtectedOffline(offline, observedUnixMs) {
  validateOfflineEnvelope(offline);
  const observed = wallTimestamp(observedUnixMs);
  if (observed < offline.appliedThroughUnixMs) {
    return {
      status: "backward_clock_held_no_advancement",
      elapsedDaysObserved: 0,
      elapsedDaysToApply: 0,
      elapsedDaysDiscardedBySafetyCap: 0,
    };
  }
  const elapsedDaysObserved = Math.floor((observed - offline.appliedThroughUnixMs) / DAY_MS);
  const elapsedDaysToApply = Math.min(elapsedDaysObserved, PROTECTED_OFFLINE_MAX_DAYS);
  return {
    status: elapsedDaysToApply > 0 ? "ready" : "below_one_day_no_advancement",
    elapsedDaysObserved,
    elapsedDaysToApply,
    elapsedDaysDiscardedBySafetyCap: elapsedDaysObserved - elapsedDaysToApply,
  };
}

function validateOfflineEnvelope(offline) {
  const keys = ["policyVersion", "savedAtUnixMs", "appliedThroughUnixMs", "activeSimulationRateAtSave", "curveStatus"];
  if (!offline || Object.keys(offline).length !== keys.length || keys.some((key) => !Object.hasOwn(offline, key))) {
    throw new Error("Vertical save offline envelope shape mismatch.");
  }
  if (offline.policyVersion !== PROTECTED_OFFLINE_POLICY_VERSION) throw new Error("Vertical save offline policy mismatch.");
  wallTimestamp(offline.savedAtUnixMs);
  wallTimestamp(offline.appliedThroughUnixMs);
  if (offline.appliedThroughUnixMs < offline.savedAtUnixMs) throw new Error("Vertical save offline timestamps are reversed.");
  if (offline.activeSimulationRateAtSave !== 1 || offline.curveStatus !== "working_1x_only_until_active_rate_curve_is_selected") {
    throw new Error("Vertical save attempted to select an unreviewed offline rate curve.");
  }
}

function wallTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Wall-clock timestamp must be a nonnegative safe integer.");
  return value;
}
