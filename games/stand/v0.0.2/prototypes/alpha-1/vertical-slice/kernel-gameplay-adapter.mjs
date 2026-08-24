import {
  COMMAND_SCHEMA_VERSION,
  KERNEL_CONTRACT_VERSION,
  PROTECTED_OFFLINE_POLICY_VERSION,
  PROPOSED_SYNTHETIC_PARAMETERS_V1,
  createKernel,
} from "../src/sim/index.mjs";
import { createKernelWorld } from "./world-view.mjs";

export function createVerticalDomainRuntime({ worldView, masterSeed, snapshot = null, initialRp = 20 }) {
  const world = createKernelWorld(worldView);
  const kernel = createKernel({ world, masterSeed, initialRp });
  if (kernel.contractVersion() !== KERNEL_CONTRACT_VERSION) throw new Error("Reviewed Kernel contract mismatch.");
  if (PROPOSED_SYNTHETIC_PARAMETERS_V1.decisionStatus !== "working-fixture-only-not-production-tuning") throw new Error("Kernel parameters were silently promoted.");
  if (snapshot) kernel.restore(migrateSnapshotToCountyWorld(snapshot, world));
  let founderSequence = 0;

  function transaction(response, receipts = []) {
    const state = kernel.inspect({ type: "state" });
    return {
      view: {
        rpTotal: state.rp.balance,
        forestStep: state.clock.step,
        elapsedUs: String(state.clock.step * 1_000_000),
        localMilestone: null,
      },
      receipts,
      events: response.events.map(toGameplayEvent),
    };
  }

  function introduceFounder() {
    const command = {
      commandSchemaVersion: COMMAND_SCHEMA_VERSION,
      commandId: `vertical-founder-${founderSequence}`,
      idempotencyKey: `vertical-founder-${founderSequence}`,
      source: "player",
      targetStep: kernel.inspect({ type: "state" }).clock.step,
      issuedSequence: founderSequence++,
      type: "introduce-founder-seed",
      payload: { cellId: worldView.selectedFounderSiteId, provenanceId: "vertical-real-oneida-working-site" },
    };
    const response = kernel.apply([command]);
    return transaction(response);
  }

  function submitSemantic(command) {
    const kernelCommand = toKernelCommand(command);
    const response = kernel.apply([kernelCommand]);
    const receipt = toGameplayReceipt(command, response.results[0]);
    return { receipt, transaction: transaction(response, [receipt]) };
  }

  function advance(steps = 1) {
    return transaction(kernel.advance({ steps }));
  }

  function advanceProtectedOffline(elapsedDays) {
    const digest = kernel.advanceProtectedOffline({
      policyVersion: PROTECTED_OFFLINE_POLICY_VERSION,
      elapsedDays,
    });
    return { digest, transaction: transaction(digest) };
  }

  return Object.freeze({
    introduceFounder,
    submitSemantic,
    advance,
    advanceProtectedOffline,
    snapshot: (reason) => kernel.snapshot(reason),
    checksum: () => kernel.checksum(),
    inspect: (request) => kernel.inspect(request),
    world,
  });
}

function migrateSnapshotToCountyWorld(snapshot, world) {
  if (snapshot.worldId === world.worldId) return snapshot;
  const localWorldId = `oneida-working-view-${world.packageIdentity.slice(0, 12)}`;
  if (snapshot.worldId !== localWorldId || snapshot.state?.worldId !== localWorldId) return snapshot;
  const migrated = structuredClone(snapshot);
  migrated.worldId = world.worldId;
  migrated.state.worldId = world.worldId;
  const existing = new Set(migrated.state.cellState.map(({ cellId }) => cellId));
  for (const cell of world.cells) if (!existing.has(cell.cellId)) {
    migrated.state.cellState.push({
      cellId: cell.cellId,
      livingCanopyPressure01: 0,
      availableLight01: cell.siteLight01,
    });
  }
  return migrated;
}

function toKernelCommand(command) {
  const common = {
    commandSchemaVersion: COMMAND_SCHEMA_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    source: "player",
    targetStep: command.targetForestStep,
    issuedSequence: Number(command.issuedSequence),
    type: command.commandType,
  };
  if (!Number.isSafeInteger(common.issuedSequence)) throw new Error("Gameplay issuedSequence exceeds the reference Kernel adapter bound.");
  if (command.commandType === "nurture-tree") {
    return { ...common, payload: { targetEntityId: command.targetEntityId } };
  }
  if (command.commandType === "release-seed-pulse") {
    return {
      ...common,
      payload: {
        sourceEntityId: command.targetEntityId,
        mode: "direct",
        holdId: command.payload.gestureId,
        pulseIndex: Number(command.payload.pulseOrdinal),
        direction: {
          x: command.payload.currentDirection.x,
          y: command.payload.currentDirection.y,
          frame: "stand-local-unitless",
          unit: "unit-vector",
        },
      },
    };
  }
  throw new Error(`Unsupported Gameplay command: ${command.commandType}`);
}

function toGameplayReceipt(command, result) {
  const accepted = result.status === "accepted";
  const authoritativeResult = {
    outcome: accepted ? "accepted" : "rejected",
    resultId: result.resultId ?? `vertical-rejection-${command.commandId}`,
    reasonCode: result.reasonCode,
    directSeedCreated: result.directSeedCreated,
    directRpAwarded: result.directRpAwarded,
  };
  if (accepted && command.commandType === "release-seed-pulse") {
    authoritativeResult.releaseId = result.minted.releaseId;
    authoritativeResult.seedId = result.minted.seedId;
    authoritativeResult.acceptedDomainEventId = result.minted.eventId;
  }
  return {
    contract: "COMMAND-RECEIPT@1",
    commandId: command.commandId,
    commandType: command.commandType,
    authoritativeResult,
  };
}

function toGameplayEvent(event) {
  const mappedType = ({
    "recruit-established": "tree-recruited",
    "tree-promoted": "tree-recruited",
    "seed-released": "seed-release-accepted",
    "local-source-extirpated": "local-source-extirpated",
  })[event.type] ?? event.type;
  return {
    contract: "DOMAIN-EVENTS@1",
    eventId: event.eventId,
    eventSequence: String(event.sequence),
    forestStep: event.step,
    channel: event.channel,
    outcome: {
      type: mappedType,
      reasonCode: event.reasonCode,
      deltaRp: event.rpDelta ?? 0,
      count: event.count ?? null,
    },
    affectedIds: event.affectedIds,
  };
}
