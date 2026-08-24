export const ELEMENT_IDS = Object.freeze([
  "scene",
  "source-label",
  "rp-total",
  "rp-delta",
  "scale-label",
  "site-factor",
  "local-feedback",
  "observe-mode",
  "seeding-mode",
  "forest-year",
  "time-state",
  "pause",
  "tick",
  "rotate-left",
  "rotate-right",
  "recenter",
  "save",
  "reload",
  "browser-save-tools",
  "export-save",
  "import-save",
  "import-file",
  "web-version-nav",
  "event-feed",
  "reduced-motion",
  "status",
]);

export function elementKey(id) {
  return id.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function bindElements(document) {
  return Object.fromEntries(ELEMENT_IDS.map((id) => {
    const element = document.querySelector(`#${id}`);
    if (!element) throw new Error(`Packaged UI is missing required element #${id}.`);
    return [elementKey(id), element];
  }));
}
