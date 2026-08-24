import { assertDomainTransaction, assertSemanticCommand, compareSemanticCommands } from "./contracts.mjs";

const CANCELLATION_ACTIONS = new Set([
  "pointer/cancel",
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

function requiredPort(port, method, label) {
  if (typeof port?.[method] !== "function") throw new Error(`${label}.${method} port is required.`);
}

export function createGameplayHostAdapter(options) {
  const { controller } = options;
  const ports = options.ports ?? {};
  if (!controller || typeof controller.dispatch !== "function") {
    throw new Error("A gameplay controller is required.");
  }
  requiredPort(ports.semanticCommands, "submit", "semanticCommands");
  let operation = Promise.resolve();

  async function routeHostIntent(intent) {
    switch (intent.type) {
      case "semantic/cancel-source":
        await ports.semanticCommands.cancelSource?.(intent.sourceId, intent.reason);
        return;
      case "preview/show-touch-contact":
        await ports.preview?.show?.(intent);
        return;
      case "preview/cancel":
        await ports.preview?.cancel?.(intent);
        return;
      case "seed/attempt-submitted":
        await ports.presentation?.attemptSubmitted?.(intent);
        return;
      case "seed/present-accepted-samara":
        await ports.presentation?.acceptedSamara?.(intent);
        return;
      case "camera/pan":
      case "camera/pinch":
      case "camera/zoom":
      case "camera/rotate":
        await ports.camera?.intent?.(intent);
        return;
      case "forest-time/set-speed":
        await ports.time?.setSpeed?.(intent.speed);
        return;
      case "forest-time/set-paused":
        await ports.time?.setPaused?.(intent.paused);
        return;
      case "preferences/changed":
        await ports.preferences?.changed?.(intent.settings);
        return;
      case "world/create-request":
        await ports.world?.create?.(intent);
        return;
      case "world/reset-request":
        await ports.world?.reset?.();
        return;
      case "persistence/save-request":
        requiredPort(ports.persistence, "save", "persistence");
        await ports.persistence.save({ uiState: controller.serializeUiState() });
        return;
      case "persistence/load-request": {
        requiredPort(ports.persistence, "load", "persistence");
        const restored = await ports.persistence.load(intent.slotId);
        controller.restoreUiState(restored.uiState);
        if (restored.transaction) controller.consumeTransaction(assertDomainTransaction(restored.transaction));
        if (restored.offlineDigest) {
          controller.dispatch({ type: "offline/show-return", digest: restored.offlineDigest });
        }
        return;
      }
      default:
        throw new Error(`Unrouted host intent: ${intent.type}`);
    }
  }

  async function flush() {
    const commands = controller.drainCommands().map(assertSemanticCommand).sort(compareSemanticCommands);
    const receipts = [];
    for (const command of commands) receipts.push(await ports.semanticCommands.submit(command));
    for (const intent of controller.drainHostIntents()) await routeHostIntent(intent);
    return { commands, receipts };
  }

  function ordered(work) {
    const result = operation.then(work);
    operation = result.catch(() => undefined);
    return result;
  }

  function dispatch(action) {
    return ordered(async () => {
      if (CANCELLATION_ACTIONS.has(action.type)) await ports.lifecycle?.beforeInputCancellation?.(action.type);
      controller.dispatch(action);
      return flush();
    });
  }

  function present(transaction) {
    return ordered(async () => {
      controller.consumeTransaction(assertDomainTransaction(transaction));
      return flush();
    });
  }

  return Object.freeze({
    dispatch,
    present,
    flush: () => ordered(flush),
    idle: () => operation,
    getViewModel: () => controller.getState(),
  });
}
