import {
  CONTROLLED_SPECIES_ID,
  FIXTURE_CONFIG,
  PERSISTED_UI_CONTRACT,
  TRUTHFUL_COPY,
} from "./config.mjs";

const SAFE_MODE = "observe";
const SETUP_STAGES = new Set(["welcome", "site", "founder", "active"]);
const DEVICES = new Set(["mouse", "touch", "pen", "keyboard"]);
const INTERRUPTION_ACTIONS = new Set([
  "input/cancel",
  "lifecycle/blur",
  "lifecycle/hidden",
  "lifecycle/suspend",
  "camera/wheel",
  "camera/rotate-start",
  "save/request",
  "load/request",
  "world/reset-request",
]);

function clone(value) {
  return structuredClone(value);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function pointDistance(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
}

function normalizeDomainDirection(direction) {
  const x = Number(direction?.x ?? 0);
  const y = Number(direction?.y ?? 0);
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  invariant(typeof direction?.frameId === "string", "Seed direction requires a stand-domain frameId.");
  return {
    contract: "STAND-DIRECTION@1",
    frameId: direction.frameId,
    unit: "unit-vector",
    x: x / magnitude,
    y: y / magnitude,
  };
}

function copyDomainPosition(position) {
  invariant(typeof position?.frameId === "string", "Seed position requires a stand-domain frameId.");
  invariant(position.unit === "micrometre", "Seed position unit must be micrometre.");
  invariant(Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y), "Seed position must use safe integers.");
  return {
    contract: "STAND-POSITION@1",
    frameId: position.frameId,
    unit: position.unit,
    x: position.x,
    y: position.y,
  };
}

function defaultSettings() {
  return {
    reducedMotion: false,
    textScale: "standard",
    soundEnabled: true,
    highContrastCues: false,
    cameraIdleDrift: true,
  };
}

function initialState(config, settings = defaultSettings()) {
  return {
    contract: "GAMEPLAY-UI-STATE@1",
    setupStage: "welcome",
    mode: SAFE_MODE,
    paused: false,
    timeSpeed: config.timeSpeeds[0],
    controlledSpeciesId: CONTROLLED_SPECIES_ID,
    speciesChoices: [CONTROLLED_SPECIES_ID],
    truthfulCopy: TRUTHFUL_COPY,
    authoritative: {
      rpTotal: 0,
      forestStep: 0,
      elapsedUs: "0",
      milestone: null,
    },
    input: null,
    cameraIntent: null,
    localFeedback: null,
    rpDelta: null,
    feed: [],
    visibleFeedCap: config.feedVisibleCap,
    screenReaderQueue: [],
    offlineReturn: null,
    settings,
  };
}

function isManagedSugarMaple(hit) {
  return Boolean(
    hit &&
      hit.entityType === "tree" &&
      hit.speciesId === CONTROLLED_SPECIES_ID &&
      hit.managed === true &&
      hit.living === true,
  );
}

function feedProjection(event) {
  const type = event?.outcome?.type ?? event?.outcomeCode;
  const reason = event?.outcome?.reasonCode ?? event?.reasonCode ?? "unspecified";
  switch (type) {
    case "seed-dispersed":
    case "seed-release-accepted":
    case "rp-awarded":
    case "rp-spent":
      return null;
    case "establishment-failed":
    case "germination-failed":
      return {
        key: `${type}:${reason}`,
        kind: "failure",
        text: reason === "insufficient-light" ? "A seedling failed in deep shade." : "A seed did not establish.",
      };
    case "local-source-extirpated":
      return {
        key: type,
        kind: "actionable",
        text: "No local sugar-maple seed source remains. Choose the recovery path to continue.",
      };
    case "tree-recruited":
      return { key: type, kind: "success", text: "A young sugar maple joined the stand." };
    case "tree-died":
      return { key: type, kind: "failure", text: "A managed sugar maple died." };
    case "gap-opened":
      return { key: type, kind: "meaningful", text: "A canopy gap opened." };
    case "advance-regen-release-started":
      return {
        key: type,
        kind: "meaningful",
        text: "Suppressed sugar-maple regeneration began to release.",
      };
    default:
      return null;
  }
}

export function createGameplayController(options = {}) {
  const now = options.now ?? (() => performance.now());
  const config = Object.freeze({ ...FIXTURE_CONFIG, ...(options.config ?? {}) });
  const idPrefix = options.idPrefix ?? "ui";
  let idCounter = 0;
  let issuedSequence = 0n;
  let state = initialState(config);
  let commandQueue = [];
  let hostIntentQueue = [];

  const nextId = (kind) => `${idPrefix}-${kind}-${++idCounter}`;

  function announce(text, priority = "polite") {
    state.screenReaderQueue.push({ id: nextId("announcement"), priority, text });
  }

  function clearEphemeral(reason) {
    if (state.input?.gestureId) {
      hostIntentQueue.push({
        type: "semantic/cancel-source",
        sourceId: state.input.gestureId,
        reason,
      });
    }
    if (state.input?.previewId) {
      hostIntentQueue.push({
        type: "preview/cancel",
        previewId: state.input.previewId,
        reason,
      });
    }
    state.input = null;
    state.cameraIntent = null;
    state.localFeedback = null;
  }

  function beginCamera(kind, pointerIds = []) {
    clearEphemeral("camera-takeover");
    state.cameraIntent = { kind, pointerIds: [...pointerIds] };
    hostIntentQueue.push({ type: `camera/${kind}`, pointerIds: [...pointerIds] });
  }

  function queueCommand(commandType, fields) {
    issuedSequence += 1n;
    const commandId = nextId("command");
    const command = {
      contract: "SEMANTIC-COMMANDS@1",
      commandId,
      idempotencyKey: `${commandId}:once`,
      dedupeGenerationId: fields.dedupeGenerationId ?? "session-generation",
      authorizedIntentId: fields.authorizedIntentId,
      commandType,
      targetForestStep: state.authoritative.forestStep,
      issuedSequence: issuedSequence.toString(),
      targetEntityId: fields.targetEntityId,
      payload: fields.payload,
    };
    commandQueue.push(command);
    return command;
  }

  function queueSeedPulse(input, timestamp, origin) {
    const direction = input.domainDirection ?? input.lastValidDirection;
    const ordinal = input.pulseOrdinal;
    const command = queueCommand("release-seed-pulse", {
      authorizedIntentId: input.gestureId,
      targetEntityId: input.sourceTreeId,
      payload: {
        contract: "RELEASE-SEED-PULSE-PAYLOAD@1",
        gestureId: input.gestureId,
        pulseOrdinal: String(ordinal),
        sourceTreeId: input.sourceTreeId,
        standPosition: clone(input.domainPosition),
        currentDirection: direction ? clone(direction) : null,
      },
    });
    input.pulseOrdinal += 1;
    input.lastAuthorizedAt = timestamp;
    input.nextPulseAt = timestamp + config.pulseCadenceMs;
    input.pendingFirst = false;
    input.previewId = null;
    hostIntentQueue.push({
      type: "seed/attempt-submitted",
      commandId: command.commandId,
      gestureId: input.gestureId,
      pulseOrdinal: String(ordinal),
      inputOrigin: origin,
    });
    return command;
  }

  function serviceInput(timestamp) {
    const input = state.input;
    if (!input || input.kind !== "seed") return;

    if (input.pendingFirst) {
      const deadline = input.downAt + config.touchPrecommitMs;
      const expires = deadline + config.touchServiceToleranceMs;
      if (timestamp > expires) {
        clearEphemeral("touch-precommit-expired");
        return;
      }
      if (timestamp >= deadline) {
        queueSeedPulse(input, timestamp, "pending-pointer-down-resolution");
        if (!input.held) state.input = null;
      }
      return;
    }

    if (!input.held || timestamp < input.nextPulseAt) return;
    queueSeedPulse(input, timestamp, "held-pulse");
  }

  function pointerDown(action) {
    invariant(DEVICES.has(action.device), `Unsupported input device: ${action.device}`);
    const timestamp = action.at ?? now();

    if (action.pointerCount >= 2 || state.input) {
      beginCamera("pinch", [state.input?.pointerId, action.pointerId].filter(Boolean));
      return;
    }
    if (state.setupStage !== "active" || state.paused) return;

    if (state.mode === "seeding") {
      const direction = normalizeDomainDirection(action.domainDirection);
      const input = {
        kind: "seed",
        device: action.device,
        pointerId: action.pointerId,
        gestureId: nextId("gesture"),
        sourceTreeId: action.sourceTreeId,
        domainPosition: copyDomainPosition(action.domainPosition),
        domainDirection: direction,
        lastValidDirection: direction,
        pulseOrdinal: 0,
        held: true,
        downAt: timestamp,
        nextPulseAt: null,
        pendingFirst: action.device === "touch",
        previewId: action.device === "touch" ? nextId("preview") : null,
      };
      state.input = input;
      if (input.pendingFirst) {
        state.localFeedback = { kind: "touch-seed-intent", authoritative: false };
        hostIntentQueue.push({
          type: "preview/show-touch-contact",
          previewId: input.previewId,
          authoritative: false,
        });
      } else {
        queueSeedPulse(input, timestamp, "pointer-down");
      }
      return;
    }

    if (isManagedSugarMaple(action.hit)) {
      state.input = {
        kind: "nurture",
        device: action.device,
        pointerId: action.pointerId,
        gestureId: nextId("gesture"),
        startPosition: clone(action.position),
        currentPosition: clone(action.position),
        target: {
          entityId: action.hit.entityId,
          entityType: "tree",
          locationRef: clone(action.hit.locationRef),
        },
      };
      state.localFeedback = {
        kind: "nurture-candidate",
        authoritative: false,
        entityId: action.hit.entityId,
        sun: action.hit.localSun ?? null,
        water: action.hit.localWater ?? null,
      };
      return;
    }

    beginCamera("pan", [action.pointerId]);
  }

  function pointerMove(action) {
    const input = state.input;
    if (!input || input.pointerId !== action.pointerId) return;
    if (input.kind === "seed") {
      if (action.domainPosition) input.domainPosition = copyDomainPosition(action.domainPosition);
      const direction = action.domainDirection ? normalizeDomainDirection(action.domainDirection) : null;
      if (direction) {
        input.domainDirection = direction;
        input.lastValidDirection = direction;
      }
      return;
    }
    input.currentPosition = clone(action.position);
    const threshold = input.device === "touch" ? config.touchDragThresholdPx : config.mouseDragThresholdPx;
    if (pointDistance(input.startPosition, input.currentPosition) >= threshold) {
      beginCamera("pan", [action.pointerId]);
    }
  }

  function pointerUp(action) {
    const timestamp = action.at ?? now();
    const input = state.input;
    if (!input || input.pointerId !== action.pointerId) {
      if (state.cameraIntent) state.cameraIntent = null;
      return;
    }
    if (input.kind === "seed") {
      input.held = false;
      if (!input.pendingFirst) state.input = null;
      serviceInput(timestamp);
      state.localFeedback = null;
      return;
    }
    queueCommand("nurture-tree", {
      authorizedIntentId: input.gestureId,
      targetEntityId: input.target.entityId,
      payload: {
        contract: "NURTURE-TREE-PAYLOAD@1",
        targetRef: { entityId: input.target.entityId, entityType: "tree" },
        targetLocationRef: clone(input.target.locationRef),
        intentionRef: {
          contractId: "SEMANTIC-COMMANDS@1",
          artifactId: input.gestureId,
        },
      },
    });
    clearEphemeral("nurture-submitted");
  }

  function setMode(mode) {
    invariant(mode === "observe" || mode === "seeding", `Unknown mode: ${mode}`);
    clearEphemeral("mode-change");
    state.mode = mode;
    announce(mode === "seeding" ? "Seeding armed." : "Observe and Nurture mode.");
  }

  function addRpDelta(amount, timestamp) {
    if (!(amount > 0)) return;
    if (state.rpDelta && timestamp < state.rpDelta.openedAt + config.rpBatchWindowMs) {
      state.rpDelta.amount += amount;
      state.rpDelta.lastAwardAt = timestamp;
      return;
    }
    state.rpDelta = {
      amount,
      openedAt: timestamp,
      lastAwardAt: timestamp,
      phase: "collecting",
    };
  }

  function addFeedRow(projection, event, timestamp) {
    const existing = state.feed.find(
      (row) => row.key === projection.key && timestamp - row.lastAt <= config.feedCoalesceMs,
    );
    if (existing) {
      existing.count += 1;
      existing.lastAt = timestamp;
      existing.eventIds.unshift(event.eventId);
      state.feed = [existing, ...state.feed.filter((row) => row !== existing)];
      return;
    }
    const dwell = projection.kind === "failure" || projection.kind === "actionable"
      ? config.failureFeedDwellMs
      : config.ordinaryFeedDwellMs;
    state.feed.unshift({
      id: nextId("feed"),
      key: projection.key,
      kind: projection.kind,
      text: projection.text,
      count: 1,
      eventIds: [event.eventId],
      firstAt: timestamp,
      lastAt: timestamp,
      expiresAt: timestamp + dwell,
    });
    state.feed = state.feed.slice(0, config.feedRetainedCap);
    announce(projection.text, projection.kind === "failure" ? "assertive" : "polite");
  }

  function consumeTransaction(transaction) {
    const timestamp = transaction.presentedAt ?? now();
    invariant(transaction.view, "A transaction requires an immutable kernel view.");
    state.authoritative.rpTotal = transaction.view.rpTotal;
    state.authoritative.forestStep = transaction.view.forestStep;
    state.authoritative.elapsedUs = String(transaction.view.elapsedUs);

    const priorMilestone = state.authoritative.milestone;
    state.authoritative.milestone = transaction.view.localMilestone ?? null;
    if (state.authoritative.milestone?.reached && !priorMilestone?.reached) {
      const text = state.authoritative.milestone.label ?? "Local regeneration milestone reached.";
      addFeedRow(
        { key: `milestone:${state.authoritative.milestone.id}`, kind: "success", text },
        { eventId: state.authoritative.milestone.eventId ?? nextId("milestone") },
        timestamp,
      );
    }

    for (const receipt of transaction.receipts ?? []) {
      if (receipt.commandType === "nurture-tree" && receipt.authoritativeResult) {
        const accepted = receipt.authoritativeResult.outcome === "accepted";
        state.localFeedback = {
          kind: accepted ? "nurture-accepted" : "nurture-rejected",
          authoritative: true,
          reasonCode: receipt.authoritativeResult.reasonCode ?? null,
          directSeedCreated: 0,
          directRpAwarded: 0,
        };
        announce(accepted ? "Nurture accepted." : "Nurture could not be applied.");
      }
      if (
        receipt.commandType === "release-seed-pulse" &&
        receipt.authoritativeResult?.outcome === "accepted"
      ) {
        hostIntentQueue.push({
          type: "seed/present-accepted-samara",
          commandId: receipt.commandId,
          resultId: receipt.authoritativeResult.resultId,
        });
      }
    }

    for (const event of transaction.events ?? []) {
      const type = event?.outcome?.type ?? event?.outcomeCode;
      if (type === "rp-awarded") addRpDelta(Number(event.outcome?.deltaRp ?? event.deltaRp), timestamp);
      const projection = feedProjection(event);
      if (projection) addFeedRow(projection, event, timestamp);
    }
  }

  function tick(timestamp = now()) {
    serviceInput(timestamp);
    if (state.rpDelta) {
      const closesAt = state.rpDelta.openedAt + config.rpBatchWindowMs;
      const settlesAt = closesAt + config.rpBatchSettleMs;
      if (timestamp >= settlesAt) state.rpDelta = null;
      else if (timestamp >= closesAt) state.rpDelta.phase = "settled";
    }
    if (!state.settings.reducedMotion) {
      state.feed = state.feed.filter((row) => timestamp < row.expiresAt || row.focused);
    }
    if (state.offlineReturn?.playing && timestamp >= state.offlineReturn.endsAt) {
      state.offlineReturn.playing = false;
      state.offlineReturn.complete = true;
    }
  }

  function dispatch(action) {
    invariant(action && typeof action.type === "string", "Actions require a type.");
    if (INTERRUPTION_ACTIONS.has(action.type)) clearEphemeral(action.type);

    switch (action.type) {
      case "setup/begin":
        state.setupStage = "site";
        return;
      case "setup/site-confirmed":
        state.setupStage = "founder";
        hostIntentQueue.push({ type: "world/create-request", speciesId: CONTROLLED_SPECIES_ID, siteRef: action.siteRef });
        return;
      case "setup/founder-landed":
        state.setupStage = "active";
        state.mode = SAFE_MODE;
        announce("Sugar maple established. Observe and nurture the stand.");
        return;
      case "mode/set":
        setMode(action.mode);
        return;
      case "pointer/down":
        pointerDown(action);
        return;
      case "pointer/move":
        pointerMove(action);
        return;
      case "pointer/up":
        pointerUp(action);
        return;
      case "pointer/cancel":
      case "input/cancel":
        clearEphemeral(action.type);
        return;
      case "input/service":
        tick(action.at ?? now());
        return;
      case "camera/wheel":
        state.cameraIntent = { kind: "zoom", delta: action.delta };
        hostIntentQueue.push({ type: "camera/zoom", delta: action.delta });
        return;
      case "camera/rotate-start":
        state.cameraIntent = { kind: "rotate" };
        hostIntentQueue.push({ type: "camera/rotate" });
        return;
      case "time/set-speed":
        invariant(config.timeSpeeds.includes(action.speed), `Unsupported fixture speed: ${action.speed}`);
        state.timeSpeed = action.speed;
        hostIntentQueue.push({ type: "forest-time/set-speed", speed: action.speed });
        return;
      case "time/set-paused":
        clearEphemeral("pause-change");
        state.paused = Boolean(action.paused);
        hostIntentQueue.push({ type: "forest-time/set-paused", paused: state.paused });
        announce(state.paused ? "Forest time paused." : "Forest time resumed.");
        return;
      case "settings/update":
        state.settings = { ...state.settings, ...action.settings };
        if (state.settings.reducedMotion) state.settings.cameraIdleDrift = false;
        hostIntentQueue.push({ type: "preferences/changed", settings: clone(state.settings) });
        return;
      case "save/request":
        hostIntentQueue.push({ type: "persistence/save-request" });
        return;
      case "load/request":
        state.mode = SAFE_MODE;
        state.feed = [];
        state.rpDelta = null;
        hostIntentQueue.push({ type: "persistence/load-request", slotId: action.slotId });
        return;
      case "world/reset-request":
        state = initialState(config, clone(state.settings));
        hostIntentQueue.push({ type: "world/reset-request" });
        return;
      case "offline/show-return": {
        const startedAt = action.at ?? now();
        state.offlineReturn = {
          digest: clone(action.digest),
          playing: !state.settings.reducedMotion,
          complete: state.settings.reducedMotion,
          startedAt,
          endsAt: startedAt + config.offlineReplayMs,
        };
        announce(`While you were away: ${action.digest.summary}`);
        return;
      }
      case "offline/skip":
        if (state.offlineReturn) {
          state.offlineReturn.playing = false;
          state.offlineReturn.complete = true;
        }
        return;
      case "feed/focus": {
        const row = state.feed.find((candidate) => candidate.id === action.id);
        if (row) row.focused = Boolean(action.focused);
        return;
      }
      case "screen-reader/drain":
        state.screenReaderQueue = [];
        return;
      case "lifecycle/blur":
      case "lifecycle/hidden":
      case "lifecycle/suspend":
        return;
      default:
        throw new Error(`Unknown action: ${action.type}`);
    }
  }

  function serializeUiState() {
    return {
      contract: PERSISTED_UI_CONTRACT,
      controlledSpeciesId: CONTROLLED_SPECIES_ID,
      setupStage: state.setupStage,
      timeSpeed: state.timeSpeed,
      settings: clone(state.settings),
    };
  }

  function restoreUiState(saved) {
    invariant(saved?.contract === PERSISTED_UI_CONTRACT, "Unsupported UI preference contract.");
    invariant(saved.controlledSpeciesId === CONTROLLED_SPECIES_ID, "This build controls sugar maple only.");
    invariant(SETUP_STAGES.has(saved.setupStage), "Invalid setup stage.");
    clearEphemeral("restore");
    state.setupStage = saved.setupStage;
    state.timeSpeed = config.timeSpeeds.includes(saved.timeSpeed) ? saved.timeSpeed : config.timeSpeeds[0];
    state.settings = { ...defaultSettings(), ...clone(saved.settings) };
    state.mode = SAFE_MODE;
    state.paused = true;
    state.feed = [];
    state.rpDelta = null;
    state.offlineReturn = null;
  }

  return Object.freeze({
    dispatch,
    tick,
    consumeTransaction,
    serializeUiState,
    restoreUiState,
    getState: () => clone(state),
    drainCommands: () => {
      const drained = commandQueue;
      commandQueue = [];
      return clone(drained);
    },
    drainHostIntents: () => {
      const drained = hostIntentQueue;
      hostIntentQueue = [];
      return clone(drained);
    },
  });
}
