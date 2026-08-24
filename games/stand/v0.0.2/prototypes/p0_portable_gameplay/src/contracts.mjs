const COMMAND_TYPES = new Set(["release-seed-pulse", "nurture-tree"]);
const PRESENTATION_ONLY_KEY = /^(device|pointer|screen|css|preview|cue|presentation|wallClock|uiTime|inputOrigin)/iu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.join("\0") === wanted.join("\0"), `${label} has unknown or missing fields: ${actual.join(", ")}`);
}

function assertNoPresentationFields(value, path = "value") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    invariant(!PRESENTATION_ONLY_KEY.test(key), `${path}.${key} is presentation/device state and cannot cross the domain seam.`);
    assertNoPresentationFields(child, `${path}.${key}`);
  }
}

function assertOpaqueId(value, label) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 160, `${label} must be a bounded opaque ID.`);
}

function assertU64String(value, label) {
  invariant(/^(0|[1-9][0-9]*)$/u.test(value), `${label} must be an unsigned decimal string.`);
}

function assertStandPosition(position) {
  exactKeys(position, ["contract", "frameId", "unit", "x", "y"], "standPosition");
  invariant(position.contract === "STAND-POSITION@1", "standPosition contract mismatch.");
  assertOpaqueId(position.frameId, "standPosition.frameId");
  invariant(position.unit === "micrometre", "standPosition unit must be micrometre.");
  invariant(Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y), "standPosition coordinates must be safe integers.");
}

function assertStandDirection(direction) {
  exactKeys(direction, ["contract", "frameId", "unit", "x", "y"], "currentDirection");
  invariant(direction.contract === "STAND-DIRECTION@1", "currentDirection contract mismatch.");
  assertOpaqueId(direction.frameId, "currentDirection.frameId");
  invariant(direction.unit === "unit-vector", "currentDirection unit must be unit-vector.");
  const magnitude = Math.hypot(direction.x, direction.y);
  invariant(Number.isFinite(magnitude) && Math.abs(magnitude - 1) <= 1e-12, "currentDirection must be normalized.");
}

export function assertSemanticCommand(command) {
  exactKeys(
    command,
    [
      "contract",
      "commandId",
      "idempotencyKey",
      "dedupeGenerationId",
      "authorizedIntentId",
      "commandType",
      "targetForestStep",
      "issuedSequence",
      "targetEntityId",
      "payload",
    ],
    "semantic command",
  );
  invariant(command.contract === "SEMANTIC-COMMANDS@1", "Semantic command contract mismatch.");
  invariant(COMMAND_TYPES.has(command.commandType), "Unsupported semantic command type.");
  for (const field of ["commandId", "idempotencyKey", "dedupeGenerationId", "authorizedIntentId", "targetEntityId"]) {
    assertOpaqueId(command[field], field);
  }
  invariant(Number.isSafeInteger(command.targetForestStep) && command.targetForestStep >= 0, "targetForestStep must be a nonnegative safe integer.");
  assertU64String(command.issuedSequence, "issuedSequence");
  assertNoPresentationFields(command);

  if (command.commandType === "release-seed-pulse") {
    exactKeys(
      command.payload,
      ["contract", "gestureId", "pulseOrdinal", "sourceTreeId", "standPosition", "currentDirection"],
      "release seed payload",
    );
    invariant(command.payload.contract === "RELEASE-SEED-PULSE-PAYLOAD@1", "Seed payload contract mismatch.");
    assertOpaqueId(command.payload.gestureId, "gestureId");
    assertU64String(command.payload.pulseOrdinal, "pulseOrdinal");
    invariant(command.targetEntityId === command.payload.sourceTreeId, "Seed source and target entity must match.");
    assertStandPosition(command.payload.standPosition);
    assertStandDirection(command.payload.currentDirection);
    invariant(
      command.payload.standPosition.frameId === command.payload.currentDirection.frameId,
      "Seed position and direction must share a frame.",
    );
  } else {
    exactKeys(command.payload, ["contract", "targetRef", "targetLocationRef", "intentionRef"], "nurture payload");
    invariant(command.payload.contract === "NURTURE-TREE-PAYLOAD@1", "Nurture payload contract mismatch.");
    invariant(command.payload.targetRef?.entityType === "tree", "Nurture target must be a tree.");
    invariant(command.payload.targetRef.entityId === command.targetEntityId, "Nurture target references must match.");
    invariant(
      command.payload.intentionRef?.artifactId === command.authorizedIntentId,
      "Nurture intention references must match.",
    );
  }
  return command;
}

export function compareSemanticCommands(left, right) {
  const leftBytes = new TextEncoder().encode(left.commandId);
  const rightBytes = new TextEncoder().encode(right.commandId);
  let idOrder = leftBytes.length - rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      idOrder = leftBytes[index] - rightBytes[index];
      break;
    }
  }
  return (
    left.targetForestStep - right.targetForestStep ||
    (BigInt(left.issuedSequence) < BigInt(right.issuedSequence) ? -1 : BigInt(left.issuedSequence) > BigInt(right.issuedSequence) ? 1 : 0) ||
    idOrder
  );
}

function assertCommandReceipt(receipt) {
  invariant(receipt?.contract === "COMMAND-RECEIPT@1", "Command receipt contract mismatch.");
  assertOpaqueId(receipt.commandId, "receipt.commandId");
  invariant(COMMAND_TYPES.has(receipt.commandType), "Receipt command type is unsupported.");
  const result = receipt.authoritativeResult;
  if (result === null) return receipt;
  invariant(result && (result.outcome === "accepted" || result.outcome === "rejected"), "Receipt requires a closed outcome.");
  assertOpaqueId(result.resultId, "receipt.resultId");
  if (receipt.commandType === "nurture-tree") {
    invariant(result.directRpAwarded === 0 && result.directSeedCreated === 0, "Nurture cannot directly award RP or create seed.");
  } else if (result.outcome === "accepted") {
    for (const field of ["releaseId", "seedId", "acceptedDomainEventId"]) assertOpaqueId(result[field], `receipt.${field}`);
  } else {
    invariant(result.releaseId === undefined && result.seedId === undefined && result.acceptedDomainEventId === undefined, "Rejected seed cannot mint domain identities.");
  }
  return receipt;
}

export function assertDomainTransaction(transaction) {
  invariant(transaction && typeof transaction === "object", "Domain transaction is required.");
  invariant(transaction.view && typeof transaction.view === "object", "Domain transaction requires an immutable view.");
  invariant(Number.isSafeInteger(transaction.view.rpTotal) && transaction.view.rpTotal >= 0, "View RP must be authoritative nonnegative integer.");
  invariant(Number.isSafeInteger(transaction.view.forestStep) && transaction.view.forestStep >= 0, "View forestStep is invalid.");
  assertU64String(String(transaction.view.elapsedUs), "view.elapsedUs");

  let priorSequence = -1n;
  const eventIds = new Set();
  for (const event of transaction.events ?? []) {
    assertOpaqueId(event.eventId, "eventId");
    invariant(event.contract === "DOMAIN-EVENTS@1", "Domain event contract mismatch.");
    assertNoPresentationFields(event, `event:${event.eventId}`);
    if (event.eventSequence !== undefined) {
      assertU64String(event.eventSequence, "eventSequence");
      const sequence = BigInt(event.eventSequence);
      invariant(sequence > priorSequence, "Domain event batch must be in ascending sequence order.");
      priorSequence = sequence;
    }
    const outcome = event.outcome?.type ?? event.outcomeCode;
    invariant(typeof outcome === "string" && outcome.length > 0, "Domain event requires an outcome code.");
    const hasRp = Number(event.outcome?.deltaRp ?? event.deltaRp ?? 0) !== 0;
    const hasFailure = Boolean(event.outcome?.reasonCode ?? event.reasonCode);
    invariant(!(hasRp && hasFailure), "RP and failure must use separate domain events.");
    eventIds.add(event.eventId);
  }
  for (const receipt of transaction.receipts ?? []) {
    assertCommandReceipt(receipt);
    const acceptedEventId = receipt.authoritativeResult?.acceptedDomainEventId;
    if (acceptedEventId) {
      invariant(eventIds.has(acceptedEventId), "Accepted seed result must resolve to its domain event in the transaction.");
    }
  }
  return transaction;
}
