import { createBrowserGenerationStorage } from "./browser-storage.mjs";

export function createPlatformHost(scope = globalThis) {
  const invoke = scope.__TAURI__?.core?.invoke;
  if (typeof invoke === "function") {
    return Object.freeze({
      kind: "native",
      async bootOptions() { return invoke("vertical_boot_options"); },
      storage(slotId) {
        return Object.freeze({
          kind: "native-atomic",
          save: (canonicalPayload) => invoke("save_spine_snapshot", { slotId, canonicalPayload }),
          load: () => invoke("load_spine_generations", { slotId }),
        });
      },
      async loadExternalWorldView() { return JSON.parse(await invoke("load_vertical_world_view")); },
      async completeVerticalSmoke(evidence) { return invoke("complete_vertical_smoke", { evidence }); },
    });
  }

  return Object.freeze({
    kind: "browser",
    async bootOptions() {
      return { testMode: false, smokeRequested: false, cacheConfigured: false };
    },
    storage(slotId) { return createBrowserGenerationStorage(slotId, { indexedDB: scope.indexedDB }); },
    async loadExternalWorldView() { throw new Error("External filesystem World data is unavailable in the browser build."); },
    async completeVerticalSmoke() { throw new Error("Native packaged-smoke completion is unavailable in the browser build."); },
  });
}
