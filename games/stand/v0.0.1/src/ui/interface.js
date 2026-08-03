const SPEED_OPTIONS = Object.freeze([1, 2, 5, 20]);

const DEFAULT_SPECIES = Object.freeze({
  id: "acer-saccharum",
  commonName: "Sugar maple",
  scientificName: "Acer saccharum",
  guidance: "Begin where cool shade and steady moisture give a samara room to establish.",
});

const DEFAULT_UNSUITABLE_MESSAGE =
  "This surface rates the site below the founding threshold. Let the samara drift to another part of the landscape.";

const TONE_DETAILS = Object.freeze({
  calm: { label: "Forest note", mark: "◇" },
  success: { label: "Growth", mark: "✓" },
  caution: { label: "Take care", mark: "!" },
  info: { label: "Notice", mark: "·" },
});

let nextInterfaceId = 1;

/**
 * Build Stand's DOM-only interface layer.
 *
 * The integration layer owns all gameplay state. Controls only request actions
 * through callbacks; update(viewModel) reflects the resulting authoritative
 * state back into the interface.
 */
export function createInterface(root, callbacks = {}) {
  if (!root || typeof root.append !== "function" || !root.ownerDocument) {
    throw new TypeError("createInterface requires a DOM element root.");
  }

  const document = root.ownerDocument;
  const instanceId = `stand-interface-${nextInterfaceId++}`;
  const removers = [];
  let destroyed = false;
  let announcementTimer = null;
  let liveRegionTimer = null;
  let currentSpecies = normalizeSpecies(DEFAULT_SPECIES);
  let reflectedState = {
    paused: false,
    plantMode: false,
    speed: 1,
    suitabilityVisible: false,
  };

  const layer = element(document, "div", "stand-interface");
  layer.dataset.standInterface = "";

  const speciesPanel = element(document, "section", "stand-panel stand-species-panel");
  speciesPanel.dataset.panel = "species-selection";
  speciesPanel.hidden = true;
  speciesPanel.setAttribute("aria-labelledby", `${instanceId}-species-heading`);

  const speciesEyebrow = element(
    document,
    "p",
    "stand-panel__eyebrow",
    "Choose your species",
  );
  speciesEyebrow.id = `${instanceId}-species-heading`;

  const speciesButton = element(document, "button", "stand-species-tile");
  speciesButton.type = "button";
  speciesButton.dataset.action = "choose-species";
  speciesButton.setAttribute("aria-describedby", `${instanceId}-species-guidance`);

  const leafMark = createSugarMapleMark(document);
  const speciesCopy = element(document, "span", "stand-species-tile__copy");
  const speciesCommonName = element(
    document,
    "span",
    "stand-species-tile__common",
    currentSpecies.commonName,
  );
  const speciesScientificName = element(
    document,
    "em",
    "stand-species-tile__scientific",
    currentSpecies.scientificName,
  );
  speciesScientificName.lang = "la";
  const speciesAction = element(
    document,
    "span",
    "stand-species-tile__action",
    "Begin here →",
  );
  speciesCopy.append(speciesCommonName, speciesScientificName, speciesAction);
  speciesButton.append(leafMark, speciesCopy);

  const speciesGuidance = element(
    document,
    "p",
    "stand-species-panel__guidance",
    currentSpecies.guidance,
  );
  speciesGuidance.id = `${instanceId}-species-guidance`;
  speciesPanel.append(speciesEyebrow, speciesButton, speciesGuidance);
  layer.append(speciesPanel);

  const guidancePanel = element(document, "section", "stand-panel stand-guidance-panel");
  guidancePanel.dataset.panel = "start-guidance";
  guidancePanel.hidden = true;
  guidancePanel.setAttribute("aria-labelledby", `${instanceId}-guidance-heading`);

  const guidanceHeading = element(
    document,
    "h2",
    "stand-panel__title",
    "Choose a place for the first tree",
  );
  guidanceHeading.id = `${instanceId}-guidance-heading`;
  guidanceHeading.tabIndex = -1;
  const guidanceCopy = element(
    document,
    "p",
    "stand-guidance-panel__copy",
    "Use the suitability wash and landscape cues, then select a promising location. Marginal places are allowed.",
  );

  const unsuitableFeedback = element(
    document,
    "div",
    "stand-unsuitable-feedback",
  );
  unsuitableFeedback.dataset.feedback = "unsuitable";
  unsuitableFeedback.hidden = true;

  const unsuitableMark = element(document, "span", "stand-unsuitable-feedback__mark", "↷");
  unsuitableMark.setAttribute("aria-hidden", "true");
  const unsuitableCopy = element(document, "div", "stand-unsuitable-feedback__copy");
  const unsuitableHeading = element(
    document,
    "h3",
    "stand-unsuitable-feedback__title",
    "Let this samara travel farther",
  );
  const unsuitableMessage = element(
    document,
    "p",
    "stand-unsuitable-feedback__message",
    DEFAULT_UNSUITABLE_MESSAGE,
  );
  const unsuitableHint = element(
    document,
    "p",
    "stand-unsuitable-feedback__hint",
    "Try another part of the wash; a marginal site is still worth exploring.",
  );
  unsuitableCopy.append(unsuitableHeading, unsuitableMessage, unsuitableHint);
  unsuitableFeedback.append(unsuitableMark, unsuitableCopy);
  guidancePanel.append(guidanceHeading, guidanceCopy, unsuitableFeedback);
  layer.append(guidancePanel);

  const readouts = element(document, "section", "stand-panel stand-readouts");
  readouts.dataset.panel = "readouts";
  readouts.setAttribute("aria-label", "Forest status");
  const readoutList = element(document, "dl", "stand-readouts__list");
  const treeReadout = createReadout(document, "Trees", "trees", "0");
  const rpReadout = createReadout(document, "RP", "rp", "0", "Regeneration Points");
  const yearsReadout = createReadout(document, "Years", "years", "0.0", "Forest years");
  const speedReadout = createReadout(document, "Speed", "speed", "1×");
  const modeReadout = createReadout(document, "Mode", "mode", "Observe");
  readoutList.append(
    treeReadout.container,
    rpReadout.container,
    yearsReadout.container,
    speedReadout.container,
    modeReadout.container,
  );
  readouts.append(readoutList);
  layer.append(readouts);

  const announcement = element(document, "div", "stand-announcement");
  announcement.dataset.tone = "calm";
  announcement.dataset.announcement = "";
  announcement.hidden = true;
  announcement.setAttribute("aria-hidden", "true");
  const announcementMark = element(document, "span", "stand-announcement__mark", "◇");
  announcementMark.setAttribute("aria-hidden", "true");
  const announcementCopy = element(document, "span", "stand-announcement__copy");
  const announcementTone = element(document, "span", "stand-visually-hidden", "Forest note: ");
  const announcementMessage = element(document, "span", "stand-announcement__message");
  announcementCopy.append(announcementTone, announcementMessage);
  announcement.append(announcementMark, announcementCopy);
  layer.append(announcement);

  const liveRegion = element(document, "p", "stand-visually-hidden");
  liveRegion.dataset.liveRegion = "";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");
  layer.append(liveRegion);

  const controls = element(document, "section", "stand-panel stand-controls");
  controls.dataset.panel = "controls";
  controls.setAttribute("aria-label", "Forest controls");

  const modeControls = element(document, "div", "stand-controls__group");
  modeControls.setAttribute("role", "group");
  modeControls.setAttribute("aria-label", "Mode and time");

  const plantControl = createToggleControl(document, "Seed", "plant-mode", "Off");
  plantControl.button.setAttribute(
    "aria-label",
    "Seeding mode off. Pointer actions cannot disperse samaras.",
  );
  const pauseButton = element(document, "button", "stand-control stand-control--pause");
  pauseButton.type = "button";
  pauseButton.dataset.action = "pause";
  pauseButton.setAttribute("aria-pressed", "false");
  const pauseMark = element(document, "span", "stand-control__mark", "‖");
  pauseMark.setAttribute("aria-hidden", "true");
  const pauseLabel = element(document, "span", "stand-control__label", "Pause");
  pauseButton.append(pauseMark, pauseLabel);
  modeControls.append(plantControl.button, pauseButton);

  const speedFieldset = element(document, "fieldset", "stand-speed-fieldset");
  const speedLegend = element(document, "legend", "stand-visually-hidden", "Simulation speed");
  const speedButtons = new Map();
  const speedOptions = element(document, "div", "stand-speed-options");
  for (const speed of SPEED_OPTIONS) {
    const speedButton = element(document, "button", "stand-speed");
    speedButton.type = "button";
    speedButton.dataset.action = "time-speed";
    speedButton.dataset.speed = String(speed);
    speedButton.setAttribute("aria-label", `${speed} times simulation speed`);
    speedButton.setAttribute("aria-pressed", speed === 1 ? "true" : "false");
    const selectedMark = element(document, "span", "stand-speed__selected", "✓");
    selectedMark.setAttribute("aria-hidden", "true");
    const speedText = element(document, "span", "stand-speed__label", `${speed}×`);
    speedButton.append(selectedMark, speedText);
    speedOptions.append(speedButton);
    speedButtons.set(speed, speedButton);
  }
  speedFieldset.append(speedLegend, speedOptions);

  const viewControls = element(document, "div", "stand-controls__group");
  viewControls.setAttribute("role", "group");
  viewControls.setAttribute("aria-label", "View and persistence");
  const suitabilityControl = createToggleControl(
    document,
    "Suitability",
    "suitability",
    "Off",
  );
  suitabilityControl.button.setAttribute("aria-label", "Show suitability");
  const saveButton = createActionControl(document, "Save", "save");
  const loadButton = createActionControl(document, "Load", "load");
  const resetButton = createActionControl(document, "Reset", "reset", "stand-control--quiet");
  viewControls.append(
    suitabilityControl.button,
    saveButton,
    loadButton,
    resetButton,
  );

  controls.append(modeControls, speedFieldset, viewControls);
  layer.append(controls);
  root.append(layer);

  listen(speciesButton, "click", () => {
    invokeCallback(callbacks, "onSpeciesChosen", currentSpecies.id);
  });
  listen(plantControl.button, "click", () => {
    invokeCallback(callbacks, "onPlantMode");
  });
  listen(pauseButton, "click", () => {
    invokeCallback(callbacks, "onPause");
  });
  for (const [speed, speedButton] of speedButtons) {
    listen(speedButton, "click", () => {
      invokeCallback(callbacks, "onTimeSpeed", speed);
    });
  }
  listen(suitabilityControl.button, "click", () => {
    invokeCallback(callbacks, "onSuitabilityToggle", !reflectedState.suitabilityVisible);
  });
  listen(saveButton, "click", () => invokeCallback(callbacks, "onSave"));
  listen(loadButton, "click", () => invokeCallback(callbacks, "onLoad"));
  listen(resetButton, "click", () => invokeCallback(callbacks, "onReset"));

  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  }

  function update(viewModel = {}) {
    if (destroyed || !viewModel || typeof viewModel !== "object") {
      return;
    }

    const treeCount = firstDefined(
      viewModel.treeCount,
      viewModel.aliveTrees,
      viewModel.treesAlive,
      viewModel.stats?.alive,
    );
    if (treeCount !== undefined) {
      setTextIfChanged(treeReadout.output, formatWholeNumber(treeCount));
    }

    const rp = firstDefined(viewModel.rp, viewModel.regenerationPoints, viewModel.stats?.rp);
    if (rp !== undefined) {
      setTextIfChanged(rpReadout.output, formatCompactNumber(rp));
    }

    const forestYears = firstDefined(
      viewModel.timeYears,
      viewModel.forestYears,
      viewModel.elapsedYears,
      viewModel.years,
    );
    if (forestYears !== undefined) {
      setTextIfChanged(yearsReadout.output, formatForestYears(forestYears));
    }

    const speed = firstDefined(viewModel.speed, viewModel.timeSpeed);
    if (speed !== undefined) {
      if (isFiniteNumber(speed) && speed >= 0) {
        reflectedState.speed = speed;
        setTextIfChanged(
          speedReadout.output,
          speed > 0 ? `${formatCompactNumber(speed)}×` : "0×",
        );
        for (const [option, button] of speedButtons) {
          button.setAttribute("aria-pressed", String(speed === option));
        }
      } else {
        setTextIfChanged(speedReadout.output, "—");
        for (const button of speedButtons.values()) {
          button.setAttribute("aria-pressed", "false");
        }
      }
    }

    const mode = firstDefined(viewModel.mode, viewModel.currentMode);
    if (mode !== undefined) {
      setTextIfChanged(modeReadout.output, formatMode(mode));
    }

    const paused = readBoolean(viewModel, "paused", "isPaused");
    if (paused !== undefined) {
      reflectedState.paused = paused;
      pauseButton.setAttribute("aria-pressed", String(paused));
      setTextIfChanged(pauseLabel, paused ? "Resume" : "Pause");
      setTextIfChanged(pauseMark, paused ? "▶" : "‖");
      pauseButton.setAttribute(
        "aria-label",
        paused ? "Resume simulation" : "Pause simulation",
      );
    }

    let plantMode = readBoolean(
      viewModel,
      "seedMode",
      "seedingMode",
      "plantMode",
      "plantModeActive",
      "isPlanting",
    );
    if (plantMode === undefined && typeof mode === "string") {
      plantMode = [
        "seed",
        "seeding",
        "seed-mode",
        "plant",
        "planting",
        "plant-mode",
      ].includes(mode.toLowerCase());
    }
    if (plantMode !== undefined) {
      reflectedState.plantMode = plantMode;
      reflectToggle(plantControl, plantMode);
      plantControl.button.setAttribute(
        "aria-label",
        plantMode
          ? "Seeding mode on. Pointer actions can disperse samaras."
          : "Seeding mode off. Pointer actions cannot disperse samaras.",
      );
    }

    const suitabilityVisible = readBoolean(
      viewModel,
      "suitabilityVisible",
      "showSuitability",
      "isSuitabilityVisible",
    );
    if (suitabilityVisible !== undefined) {
      reflectedState.suitabilityVisible = suitabilityVisible;
      reflectToggle(suitabilityControl, suitabilityVisible);
    }

    reflectAvailability(plantControl.button, viewModel.canPlant);
    reflectAvailability(pauseButton, viewModel.canPause);
    reflectAvailability(saveButton, viewModel.canSave);
    reflectAvailability(loadButton, viewModel.canLoad);
    reflectAvailability(resetButton, viewModel.canReset);
    reflectAvailability(
      suitabilityControl.button,
      firstDefined(viewModel.canToggleSuitability, viewModel.canShowSuitability),
    );
  }

  function announce(message, tone = "calm") {
    if (destroyed) {
      return;
    }

    const text = messageText(message);
    if (!text) {
      hideAnnouncement();
      return;
    }

    const normalizedTone = normalizeTone(tone);
    const toneDetails = TONE_DETAILS[normalizedTone];
    if (announcementTimer !== null) {
      clearScheduledTimer(document, announcementTimer);
      announcementTimer = null;
    }

    announcement.dataset.tone = normalizedTone;
    setTextIfChanged(announcementMark, toneDetails.mark);
    setTextIfChanged(announcementTone, `${toneDetails.label}: `);
    setTextIfChanged(announcementMessage, text);
    announcement.hidden = false;
    queueLiveMessage(`${toneDetails.label}: ${text}`);

    const duration = normalizedTone === "caution" ? 6500 : 4800;
    announcementTimer = scheduleTimer(document, () => {
      announcementTimer = null;
      if (!destroyed) {
        announcement.hidden = true;
      }
    }, duration);
  }

  function showSpeciesSelection(species = DEFAULT_SPECIES) {
    if (destroyed) {
      return;
    }

    currentSpecies = normalizeSpecies(species);
    setTextIfChanged(speciesCommonName, currentSpecies.commonName);
    setTextIfChanged(speciesScientificName, currentSpecies.scientificName);
    setTextIfChanged(speciesGuidance, currentSpecies.guidance);
    speciesButton.setAttribute(
      "aria-label",
      `Choose ${currentSpecies.commonName}, ${currentSpecies.scientificName}`,
    );
    guidancePanel.hidden = true;
    unsuitableFeedback.hidden = true;
    speciesPanel.hidden = false;
    focusWithoutScroll(speciesButton);
  }

  function showStartGuidance() {
    if (destroyed) {
      return;
    }

    speciesPanel.hidden = true;
    unsuitableFeedback.hidden = true;
    guidancePanel.hidden = false;
    focusWithoutScroll(guidanceHeading);
  }

  function showUnsuitableFeedback(details = {}) {
    if (destroyed) {
      return;
    }

    const normalized = normalizeUnsuitableDetails(details);
    setTextIfChanged(unsuitableHeading, normalized.title);
    setTextIfChanged(unsuitableMessage, normalized.message);
    setTextIfChanged(unsuitableHint, normalized.hint);
    speciesPanel.hidden = true;
    guidancePanel.hidden = false;
    unsuitableFeedback.hidden = false;
    queueLiveMessage(`${normalized.title}. ${normalized.message} ${normalized.hint}`);
  }

  function queueLiveMessage(message) {
    if (liveRegionTimer !== null) {
      clearScheduledTimer(document, liveRegionTimer);
      liveRegionTimer = null;
    }
    liveRegion.textContent = "";
    liveRegionTimer = scheduleTimer(document, () => {
      liveRegionTimer = null;
      if (!destroyed) {
        liveRegion.textContent = message;
      }
    }, 30);
  }

  function hideAnnouncement() {
    if (announcementTimer !== null) {
      clearScheduledTimer(document, announcementTimer);
      announcementTimer = null;
    }
    if (liveRegionTimer !== null) {
      clearScheduledTimer(document, liveRegionTimer);
      liveRegionTimer = null;
    }
    announcement.hidden = true;
    announcementMessage.textContent = "";
    liveRegion.textContent = "";
  }

  function destroy() {
    if (destroyed) {
      return;
    }

    destroyed = true;
    if (announcementTimer !== null) {
      clearScheduledTimer(document, announcementTimer);
      announcementTimer = null;
    }
    if (liveRegionTimer !== null) {
      clearScheduledTimer(document, liveRegionTimer);
      liveRegionTimer = null;
    }
    for (const remove of removers.splice(0)) {
      remove();
    }
    layer.remove();
  }

  return Object.freeze({
    update,
    announce,
    showSpeciesSelection,
    showStartGuidance,
    showUnsuitableFeedback,
    destroy,
  });
}

function element(document, tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function createSugarMapleMark(document) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("stand-species-tile__leaf");
  svg.setAttribute("viewBox", "0 0 72 80");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const leaf = document.createElementNS(namespace, "path");
  leaf.setAttribute(
    "d",
    "M36 4 30 19 20 13 22 28 8 24 16 39 5 43 28 53 25 68 34 61 36 76 38 61 47 68 44 53 67 43 56 39 64 24 50 28 52 13 42 19Z",
  );
  const vein = document.createElementNS(namespace, "path");
  vein.setAttribute("d", "M36 17v48M36 47 19 34M36 47l17-13M36 53 26 59M36 53l10 6");
  vein.setAttribute("class", "stand-species-tile__leaf-vein");
  svg.append(leaf, vein);
  return svg;
}

function createReadout(document, label, key, initialValue, expandedLabel = label) {
  const container = element(document, "div", "stand-readout");
  const term = element(document, "dt", "stand-readout__label", label);
  if (expandedLabel !== label) {
    term.setAttribute("title", expandedLabel);
    term.setAttribute("aria-label", expandedLabel);
  }
  const description = element(document, "dd", "stand-readout__value");
  const output = element(document, "span", "stand-readout__output", initialValue);
  output.dataset.readout = key;
  description.append(output);
  container.append(term, description);
  return { container, output };
}

function createToggleControl(document, label, action, initialState) {
  const button = element(document, "button", "stand-control stand-control--toggle");
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-pressed", "false");
  const copy = element(document, "span", "stand-control__label", label);
  const state = element(document, "span", "stand-control__state", initialState);
  state.setAttribute("aria-hidden", "true");
  button.append(copy, state);
  return { button, state };
}

function createActionControl(document, label, action, modifier = "") {
  const className = ["stand-control", modifier].filter(Boolean).join(" ");
  const button = element(document, "button", className, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function reflectToggle(control, active) {
  control.button.setAttribute("aria-pressed", String(active));
  setTextIfChanged(control.state, active ? "On" : "Off");
}

function reflectAvailability(control, available) {
  if (typeof available === "boolean") {
    control.disabled = !available;
  }
}

function normalizeSpecies(species) {
  if (typeof species === "string") {
    return { ...DEFAULT_SPECIES };
  }

  const source = species && typeof species === "object" ? species : DEFAULT_SPECIES;
  const requestedId = safeText(firstDefined(source.id, source.speciesId), "");
  const requestedCommonName = safeText(
    firstDefined(source.commonName, source.name, source.displayName),
    "",
  );
  const requestedScientificName = safeText(
    firstDefined(source.scientificName, source.scientific, source.binomial),
    "",
  );
  if (
    (requestedId && requestedId !== DEFAULT_SPECIES.id) ||
    (requestedCommonName &&
      requestedCommonName.toLowerCase() !== DEFAULT_SPECIES.commonName.toLowerCase()) ||
    (requestedScientificName &&
      requestedScientificName.toLowerCase() !== DEFAULT_SPECIES.scientificName.toLowerCase())
  ) {
    return { ...DEFAULT_SPECIES };
  }
  return {
    id: DEFAULT_SPECIES.id,
    commonName: safeText(
      firstDefined(source.commonName, source.name, source.displayName),
      DEFAULT_SPECIES.commonName,
    ),
    scientificName: safeText(
      firstDefined(source.scientificName, source.scientific, source.binomial),
      DEFAULT_SPECIES.scientificName,
    ),
    guidance: safeText(
      firstDefined(source.guidance, source.description, source.habitatGuidance),
      DEFAULT_SPECIES.guidance,
    ),
  };
}

function normalizeUnsuitableDetails(details) {
  if (typeof details === "string") {
    return {
      title: "Let this samara travel farther",
      message: safeText(details, DEFAULT_UNSUITABLE_MESSAGE),
      hint: "Try another part of the wash; a marginal site is still worth exploring.",
    };
  }

  const source = details && typeof details === "object" ? details : {};
  return {
    title: safeText(source.title, "Let this samara travel farther"),
    message: safeText(
      firstDefined(source.message, readableReason(source.reason)),
      DEFAULT_UNSUITABLE_MESSAGE,
    ),
    hint: safeText(
      firstDefined(source.hint, source.suggestion),
      "Try another part of the wash; a marginal site is still worth exploring.",
    ),
  };
}

function readableReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    return undefined;
  }
  if (["low-suitability", "unsuitable", "below-minimum-suitability"].includes(reason)) {
    return DEFAULT_UNSUITABLE_MESSAGE;
  }
  return humanize(reason);
}

function normalizeTone(tone) {
  const value = typeof tone === "string" ? tone.toLowerCase() : "calm";
  if (value === "success" || value === "growth" || value === "positive") {
    return "success";
  }
  if (
    value === "caution" ||
    value === "warning" ||
    value === "error" ||
    value === "unsuitable"
  ) {
    return "caution";
  }
  if (value === "info" || value === "notice") {
    return "info";
  }
  return "calm";
}

function messageText(message) {
  if (message && typeof message === "object") {
    return safeText(firstDefined(message.message, message.text), "");
  }
  return safeText(message, "");
}

function formatWholeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  return String(Math.max(0, Math.floor(number)));
}

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  const bounded = Math.max(0, number);
  if (Number.isInteger(bounded)) {
    return String(bounded);
  }
  return bounded.toFixed(1).replace(/\.0$/, "");
}

function formatForestYears(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  const bounded = Math.max(0, number);
  if (bounded < 10) {
    return bounded.toFixed(1);
  }
  if (bounded < 100) {
    return bounded.toFixed(1).replace(/\.0$/, "");
  }
  return String(Math.round(bounded));
}

function formatMode(mode) {
  if (mode && typeof mode === "object") {
    return safeText(firstDefined(mode.label, mode.name), "Observe");
  }
  const value = safeText(mode, "Observe");
  const normalized = value.toLowerCase();
  const labels = {
    observe: "Observe",
    explore: "Explore",
    nurture: "Nurture",
    seed: "Seeding",
    seeding: "Seeding",
    "seed-mode": "Seeding",
    plant: "Seeding",
    planting: "Seeding",
    "plant-mode": "Seeding",
    "select-founder": "Choose a site",
    "founder-placement": "Choose a site",
    "choose-site": "Choose a site",
  };
  return labels[normalized] || humanize(value);
}

function humanize(value) {
  return String(value)
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function safeText(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function readBoolean(source, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function setTextIfChanged(node, value) {
  if (node.textContent !== value) {
    node.textContent = value;
  }
}

function focusWithoutScroll(node) {
  if (!node || typeof node.focus !== "function") {
    return;
  }
  try {
    node.focus({ preventScroll: true });
  } catch {
    node.focus();
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function invokeCallback(callbacks, name, ...args) {
  const callback = callbacks && callbacks[name];
  if (typeof callback === "function") {
    callback(...args);
  }
}

function scheduleTimer(document, callback, delay) {
  const timerHost = document.defaultView || globalThis;
  return timerHost.setTimeout(callback, delay);
}

function clearScheduledTimer(document, timer) {
  const timerHost = document.defaultView || globalThis;
  timerHost.clearTimeout(timer);
}
