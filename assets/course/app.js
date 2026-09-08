const app = document.querySelector("#course-app");
const view = document.querySelector("#course-view");
const progressLabel = document.querySelector("#course-progress-label");
const progressBar = document.querySelector("#course-progress-bar");
const mobileMenu = document.querySelector("#course-mobile-nav");
const menuButton = document.querySelector("#course-menu-button");
const imageDialog = document.querySelector("#course-image-dialog");
const storageStatus = document.querySelector("#course-storage-status");
const storageSchemaVersion = 3;
const storageKey = "cochetopa-northern-hardwoods-course-v3";
const supersededStorageKeys = ["cochetopa-northern-hardwoods-course-v2", "cochetopa-northern-hardwoods-preview-v2"];

let course;
let courseCatalog;
let publicMedia;
let mediaById = new Map();
const teachingPackages = new Map();
const formalForms = new Map();
let storageAvailable = true;
let pendingCloudState = window.cochetopaCloudSnapshot || null;
let formalTrackingRefresh = null;
let state = loadState();

function blankAssessment() {
  return { submitted: false, responses: {}, identityScore: null, maximumScore: null, itemOrder: [] };
}

function defaultState(courseVersion = null) {
  return {
    storageSchemaVersion,
    courseVersion,
    completed: [],
    completedRoutes: [],
    practiceSessions: {},
    formalAssessments: {},
    gradeSummary: null,
    assessments: {
      visualLab: blankAssessment(),
      confuserLab: blankAssessment(),
      multiOrganLab: blankAssessment(),
      checkpoint: blankAssessment(),
      nomenclatureDrill: blankAssessment(),
      silvicsDrill: blankAssessment(),
      weeklyPractical: blankAssessment(),
    },
  };
}

function loadState() {
  try {
    const serialized = localStorage.getItem(storageKey);
    const parsed = JSON.parse(serialized);
    if (!parsed || parsed.storageSchemaVersion !== storageSchemaVersion || !Array.isArray(parsed.completed)) {
      return defaultState();
    }
    parsed.assessments ||= {};
    parsed.completedRoutes ||= [];
    parsed.practiceSessions ||= {};
    parsed.formalAssessments ||= {};
    parsed.gradeSummary ||= null;
    ["visualLab", "confuserLab", "multiOrganLab", "checkpoint", "nomenclatureDrill", "silvicsDrill", "weeklyPractical"].forEach((key) => {
      parsed.assessments[key] ||= blankAssessment();
      parsed.assessments[key].itemOrder ||= [];
    });
    return parsed;
  } catch {
    storageAvailable = false;
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    supersededStorageKeys.forEach((key) => localStorage.removeItem(key));
    storageAvailable = true;
    if (storageStatus) storageStatus.hidden = true;
  } catch {
    storageAvailable = false;
    if (storageStatus) {
      storageStatus.textContent = "This browser blocked local course storage. Your responses will remain only until this page is closed or reloaded.";
      storageStatus.hidden = false;
    }
  }
  updateProgress();
  window.dispatchEvent(new CustomEvent("cochetopa-local-state", { detail: state }));
}

function prepareStateForCourse() {
  if (state.courseVersion !== course.courseVersion) {
    state.courseVersion = course.courseVersion;
    saveState();
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeAnswer(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchesAnswer(value, accepted) {
  const normalized = normalizeAnswer(value);
  return accepted.some((answer) => normalizeAnswer(answer) === normalized);
}

function markComplete(activityId) {
  if (!state.completed.includes(activityId)) {
    state.completed.push(activityId);
    saveState();
  }
}

function markRouteComplete(route) {
  if (!state.completedRoutes.includes(route)) {
    state.completedRoutes.push(route);
    saveState();
  }
}

function formalAssessmentComplete(record) {
  if (!record) return false;
  if (Number(record.totalItems) > 0 && Number(record.submittedItems) >= Number(record.totalItems)) return true;
  return ["awaiting_review", "completed", "submitted", "locked"].includes(record.status);
}

function weekOneActivityRoute(activityId) {
  const routes = {
    briefing: "week-01",
    "session-a": "week-01/session-a",
    "visual-lab": "week-01/visual-lab",
    "confuser-lab": "week-01/confuser-lab",
    "multi-organ-lab": "week-01/multi-organ-lab",
    checkpoint: "week-01/checkpoint",
    "weekly-practical": "week-01/weekly-practical",
  };
  return routes[activityId];
}

function moduleActivityRecords(module) {
  if (!course || !courseCatalog) return [];
  const learningActivities = module.sequence === 1
    ? course.week.activities.map((activity) => ({
        key: `week-01:${activity.id}`,
        label: activity.title,
        route: weekOneActivityRoute(activity.id),
        complete: state.completed.includes(activity.id),
      }))
    : [
        {
          key: `route:${module.moduleId}`,
          label: "Week briefing",
          route: module.moduleId,
          complete: state.completedRoutes.includes(module.moduleId),
        },
        ...module.sessions.map((session) => {
          const route = `${module.moduleId}/session-${session.letter.toLowerCase()}`;
          return {
            key: `route:${route}`,
            label: `Session ${session.letter} · ${session.title}`,
            route,
            complete: state.completedRoutes.includes(route),
          };
        }),
      ];
  const assessments = module.assessments.map((assessment) => ({
    key: `formal:${assessment.assessmentId}`,
    label: `Assessment · ${assessment.assessmentId}`,
    route: `formal/${encodeURIComponent(assessment.assessmentId)}`,
    complete: formalAssessmentComplete(state.formalAssessments[assessment.assessmentId]),
  }));
  return [...learningActivities, ...assessments];
}

function courseActivityRecords() {
  if (!courseCatalog) return [];
  return courseCatalog.modules.flatMap(moduleActivityRecords);
}

function moduleProgress(module) {
  const activities = moduleActivityRecords(module);
  return {
    completed: activities.filter((activity) => activity.complete).length,
    total: activities.length,
  };
}

function courseProgressTotals() {
  const activities = courseActivityRecords();
  return {
    completed: activities.filter((activity) => activity.complete).length,
    total: activities.length,
  };
}

function nextCourseActivity() {
  return courseActivityRecords().find((activity) => !activity.complete) || null;
}

function rememberFormalForm(form) {
  if (!form?.assessmentId) return;
  const visualItems = form.stations || [];
  const nonvisualItems = form.items || [];
  const next = {
    status: form.status || "assembled",
    totalItems: visualItems.length + nonvisualItems.length,
    submittedItems: visualItems.filter((item) => item.submitted).length + nonvisualItems.filter((item) => item.submitted).length,
  };
  const previous = state.formalAssessments[form.assessmentId];
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    state.formalAssessments[form.assessmentId] = next;
    saveState();
  }
}

async function refreshFormalTracking({ rerender = false } = {}) {
  const auth = window.cochetopaAuth;
  if (!course || !auth?.enabled || !auth.signedIn()) return null;
  if (formalTrackingRefresh) return formalTrackingRefresh;
  formalTrackingRefresh = (async () => {
    const summary = await auth.getGradeSummary();
    state.gradeSummary = {
      runningGrade: summary.runningGrade ?? null,
      earnedWeight: Number(summary.earnedWeight || 0),
      categories: summary.categories || [],
    };
    for (const assessment of summary.assessments || []) {
      state.formalAssessments[assessment.assessmentId] = {
        status: assessment.status,
        totalItems: Number(assessment.totalItems || 0),
        submittedItems: Number(assessment.submittedItems || 0),
      };
    }
    saveState();
    return summary;
  })();
  try {
    const summary = await formalTrackingRefresh;
    if (rerender && ["dashboard", ...courseCatalog.modules.map((module) => module.moduleId)].includes(currentRoute())) {
      await renderRoute();
    }
    return summary;
  } catch (error) {
    console.warn("Course grade summary refresh failed.", error);
    return null;
  } finally {
    formalTrackingRefresh = null;
  }
}

function mergeAssessmentState(local = blankAssessment(), remote = blankAssessment()) {
  const remotePreferred = remote.submitted && !local.submitted;
  if (remotePreferred) {
    return {
      ...local,
      ...remote,
      responses: { ...(remote.responses || {}) },
      itemOrder: remote.itemOrder?.length ? remote.itemOrder : (local.itemOrder || []),
    };
  }
  const merged = { ...remote, ...local };
  merged.responses = { ...(remote.responses || {}), ...(local.responses || {}) };
  merged.itemOrder = local.itemOrder?.length ? local.itemOrder : (remote.itemOrder || []);
  return merged;
}

function mergePracticeState(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  if (remote.submitted && !local.submitted) return remote;
  return {
    ...remote,
    ...local,
    responses: { ...(remote.responses || {}), ...(local.responses || {}) },
    itemOrder: local.itemOrder?.length ? local.itemOrder : (remote.itemOrder || []),
  };
}

function applyCloudState(cloud, { rerender = true } = {}) {
  if (!cloud || cloud.storageSchemaVersion !== storageSchemaVersion) return false;
  state.completed = [...new Set([...(cloud.completed || []), ...state.completed])];
  state.completedRoutes = [...new Set([...(cloud.completedRoutes || []), ...(state.completedRoutes || [])])];

  const practiceRoutes = new Set([
    ...Object.keys(cloud.practiceSessions || {}),
    ...Object.keys(state.practiceSessions || {}),
  ]);
  state.practiceSessions = Object.fromEntries(
    [...practiceRoutes].map((route) => [
      route,
      mergePracticeState(state.practiceSessions?.[route], cloud.practiceSessions?.[route]),
    ])
  );

  for (const key of Object.keys(state.assessments)) {
    state.assessments[key] = mergeAssessmentState(state.assessments[key], cloud.assessments?.[key]);
  }

  for (const [assessmentId, remote] of Object.entries(cloud.formalAssessments || {})) {
    const local = state.formalAssessments[assessmentId];
    if (!local || Number(remote.submittedItems || 0) > Number(local.submittedItems || 0)) {
      state.formalAssessments[assessmentId] = remote;
    }
  }
  if (!state.gradeSummary && cloud.gradeSummary) state.gradeSummary = cloud.gradeSummary;
  state.courseVersion = course?.courseVersion || state.courseVersion;
  saveState();
  if (rerender) renderRoute();
  return true;
}

function refreshNavigationState() {
  if (!courseCatalog) return;
  const activities = new Map(courseActivityRecords().map((activity) => [activity.key, activity]));
  document.querySelectorAll(".course-nav__link[data-track-key]").forEach((button) => {
    const complete = Boolean(activities.get(button.dataset.trackKey)?.complete);
    button.classList.toggle("course-nav__link--complete", complete);
    const status = button.querySelector(".course-nav__status");
    if (status) status.textContent = complete ? "Complete" : "";
  });
  document.querySelectorAll(".course-nav__week[data-module-id]").forEach((group) => {
    const module = courseCatalog.modules.find((candidate) => candidate.moduleId === group.dataset.moduleId);
    if (!module) return;
    const progress = moduleProgress(module);
    const badge = group.querySelector(".course-nav__week-progress");
    if (badge) badge.textContent = `${progress.completed}/${progress.total}`;
  });
}

function updateProgress() {
  const progress = courseProgressTotals();
  const total = progress.total || 1;
  if (progressLabel) progressLabel.textContent = `${progress.completed} of ${progress.total} course activities`;
  if (progressBar) {
    progressBar.max = total;
    progressBar.value = progress.completed;
    progressBar.textContent = `${progress.completed} of ${progress.total} course activities`;
  }
  refreshNavigationState();
}

function sessionEIsComplete() {
  return ["checkpoint", "nomenclatureDrill", "silvicsDrill"].every(
    (key) => state.assessments[key]?.submitted
  );
}

function firstMissingSessionERoute() {
  if (!state.assessments.checkpoint.submitted) return "week-01/checkpoint";
  if (!state.assessments.nomenclatureDrill.submitted) return "week-01/session-e/nomenclature";
  if (!state.assessments.silvicsDrill.submitted) return "week-01/session-e/silvics";
  return "week-01/weekly-practical";
}

function currentRoute() {
  return window.location.hash.replace(/^#\/?/, "") || "dashboard";
}

function go(route) {
  const nextHash = `#/${route}`;
  if (window.location.hash === nextHash) {
    renderRoute();
  } else {
    window.location.hash = nextHash;
  }
}

function setActiveNavigation(route) {
  const activeRoute = route.startsWith("week-01/session-e/")
    ? "week-01/checkpoint"
    : route;
  const formalMatch = route.match(/^formal\/(.+)$/);
  const formalRecord = formalMatch ? assessmentCatalogRecord(decodeURIComponent(formalMatch[1])) : null;
  const moduleId = formalRecord?.module.moduleId || route.match(/^(week-(?:0[1-9]|10))/)?.[1] || null;

  document.querySelectorAll(".course-nav__link").forEach((button) => {
    if (button.dataset.route === activeRoute) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  document.querySelectorAll(".course-nav__week").forEach((group) => {
    group.open = Boolean(moduleId && group.dataset.moduleId === moduleId);
  });
}

function pageHeader(kicker, title, lede) {
  return `
    <header>
      <p class="course-kicker">${escapeHtml(kicker)}</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="course-lede">${escapeHtml(lede)}</p>
    </header>
  `;
}

function formatToken(value = "") {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCamelToken(value = "") {
  return formatToken(String(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

function stableNumber(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomIndex(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  if (window.crypto?.getRandomValues) {
    const upperBound = 0x100000000 - (0x100000000 % maxExclusive);
    const value = new Uint32Array(1);
    do window.crypto.getRandomValues(value); while (value[0] >= upperBound);
    return value[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function shuffledIds(items, keyForItem) {
  const ids = items.map(keyForItem);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  }
  return ids;
}

function itemsInAttemptOrder(items, record, keyForItem) {
  const sourceIds = items.map(keyForItem);
  const sourceIdSet = new Set(sourceIds);
  const storedOrderIsValid = Array.isArray(record.itemOrder)
    && record.itemOrder.length === sourceIds.length
    && new Set(record.itemOrder).size === sourceIds.length
    && record.itemOrder.every((id) => sourceIdSet.has(id));
  if (!storedOrderIsValid) {
    record.itemOrder = shuffledIds(items, keyForItem);
    saveState();
  }
  const byId = new Map(items.map((item) => [keyForItem(item), item]));
  return record.itemOrder.map((id) => byId.get(id));
}

function mediaForTaxon(taxonId, pool, count = 3, salt = "") {
  const candidates = publicMedia.media
    .filter((item) => item.taxonId === taxonId && item.pool === pool)
    .sort((left, right) => stableNumber(`${salt}|${left.mediaId}`) - stableNumber(`${salt}|${right.mediaId}`));
  const chosen = [];
  const seenModalities = new Set();
  for (const item of candidates) {
    if (chosen.length >= count) break;
    if (!seenModalities.has(item.primaryModality)) {
      chosen.push(item);
      seenModalities.add(item.primaryModality);
    }
  }
  for (const item of candidates) {
    if (chosen.length >= count) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen;
}

function publicMediaImage(item, labeled = true) {
  const identity = `${item.preferredCommonName} — ${item.canonicalScientificName}`;
  const caption = labeled
    ? `${identity}. ${formatToken(item.primaryModality)}; reviewed ceiling: ${formatToken(item.answerCeiling)}.`
    : `Unfamiliar ${formatToken(item.primaryModality)} practice specimen.`;
  const alt = labeled
    ? `${item.preferredCommonName}, ${formatToken(item.primaryModality)} teaching specimen`
    : `Unlabeled ${formatToken(item.primaryModality)} tree-identification specimen`;
  return `
    <figure class="course-image-card">
      <button class="course-zoom-button js-zoom" type="button" aria-label="Enlarge ${escapeHtml(alt)}" data-src="${escapeHtml(item.imageUrl)}" data-alt="${escapeHtml(alt)}" data-caption="${escapeHtml(caption)}" data-attribution="${escapeHtml(item.creatorAttribution)}" data-source-url="${escapeHtml(item.photoPageUrl)}">
        <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer" />
      </button>
      <figcaption><strong>${escapeHtml(formatToken(item.primaryModality))}</strong>${escapeHtml(caption)}${attributionMarkup({ attribution: item.creatorAttribution, sourceUrl: item.photoPageUrl })}</figcaption>
    </figure>
  `;
}

function teachingMediaMarkup(profile) {
  const images = mediaForTaxon(profile.taxonId, "teaching", 3, `teach-${profile.taxonId}`);
  if (!images.length) return "";
  return `
    <section class="course-profile-section">
      <h3>Independent teaching specimens</h3>
      <p>These labeled views teach transferable characters. Practice and examination specimens are held in different pools.</p>
      <div class="course-image-grid course-image-grid--compact">${images.map((item) => publicMediaImage(item, true)).join("")}</div>
    </section>
  `;
}

function completionButton(activityId, nextRoute, label = "Mark complete and continue") {
  const completed = state.completed.includes(activityId);
  return `
    <div class="course-actions">
      <button class="course-button js-complete" type="button" data-activity="${activityId}" data-next-route="${nextRoute}">
        ${completed ? "Completed — continue" : escapeHtml(label)}
      </button>
    </div>
  `;
}

function renderDashboard() {
  const progress = courseProgressTotals();
  const nextActivity = nextCourseActivity();
  const resumeRoute = nextActivity?.route || "week-10";
  const completedFormal = courseCatalog.modules
    .flatMap((module) => module.assessments)
    .filter((assessment) => formalAssessmentComplete(state.formalAssessments[assessment.assessmentId]))
    .length;
  const grade = state.gradeSummary?.runningGrade;
  const gradeText = grade == null ? "Sign in to show a running grade." : `Current running grade: ${grade}%.`;

  const moduleCards = courseCatalog.modules.map((module) => {
    const moduleStatus = moduleProgress(module);
    const taxonLine = module.newTaxa.length
      ? `${module.newTaxa.length} new taxa · ${module.cumulativeEligibleTaxa} cumulative`
      : `${module.cumulativeEligibleTaxa} cumulative taxa · no new taxa`;
    return `
      <article class="course-module-card">
        <div class="course-module-card__topline"><span>Week ${module.sequence}</span><span>${moduleStatus.completed}/${moduleStatus.total} complete</span></div>
        <h3>${escapeHtml(module.title)}</h3>
        <p>${escapeHtml(taxonLine)}</p>
        <p>${module.sessions.length} sessions · ${module.assessments.length} graded assessment${module.assessments.length === 1 ? "" : "s"}</p>
        <button class="course-link-button js-route" type="button" data-route="${escapeHtml(module.moduleId)}">Open Week ${module.sequence}</button>
      </article>
    `;
  }).join("");

  view.innerHTML = `
    ${pageHeader(
      "Course home",
      "Field identification starts with evidence",
      "Work through the complete ten-week course using independent teaching specimens, unfamiliar retrieval, confuser control, cumulative testing, and calibrated evidence limits."
    )}
    <p class="course-notice"><strong>Your progress:</strong> work is saved immediately on this device. Sign in with an email link to synchronize course progress, secure assessments, grades, and reminder preferences across devices.</p>
    <section class="course-dashboard-grid" aria-label="Course status">
      <article class="course-dashboard-card"><span class="course-dashboard-card__value">${progress.completed}/${progress.total}</span><h2>Course activities</h2><p>Briefings, instructional sessions, practice laboratories, and formal assessments.</p></article>
      <article class="course-dashboard-card"><span class="course-dashboard-card__value">${courseCatalog.taxonCount}</span><h2>Principal taxa</h2><p>Tiered across northern hardwood, mixedwood, boreal-transition, Acadian, lowland, and Allegheny systems.</p></article>
      <article class="course-dashboard-card"><span class="course-dashboard-card__value">${completedFormal}/${courseCatalog.gradedAssessmentCount}</span><h2>Graded assessments</h2><p>${escapeHtml(gradeText)}</p></article>
    </section>
    <div class="course-actions">
      <button class="course-button js-route" type="button" data-route="${escapeHtml(resumeRoute)}">${nextActivity ? "Begin or resume course" : "Review the completed course"}</button>
      <button class="course-link-button" id="reset-course" type="button">Reset this-device study data</button>
    </div>
    <section class="course-module-catalog" aria-labelledby="course-module-catalog-title">
      <div class="course-section-heading">
        <p class="course-kicker">Ten-week sequence</p>
        <h2 id="course-module-catalog-title">Curriculum map</h2>
        <p>Weeks remain cumulative. A later week never removes an earlier species from retrieval eligibility.</p>
      </div>
      <div class="course-module-grid">${moduleCards}</div>
    </section>
  `;
}

function routeForCatalogSession(module, session) {
  if (module.sequence !== 1) return `${module.moduleId}/session-${session.letter.toLowerCase()}`;
  const routes = {
    A: "week-01/session-a",
    B: "week-01/visual-lab",
    C: "week-01/confuser-lab",
    D: "week-01/multi-organ-lab",
    E: "week-01/checkpoint",
  };
  return routes[session.letter];
}

function renderModuleOverview(module) {
  const progress = moduleProgress(module);
  const briefingComplete = state.completedRoutes.includes(module.moduleId);
  const firstSessionRoute = routeForCatalogSession(module, module.sessions[0]);
  const taxaMarkup = module.newTaxa.length
    ? `<ul class="course-taxon-list">${module.newTaxa.map((taxon) => `<li><strong>${escapeHtml(taxon.preferredCommonName)}</strong><span><i>${escapeHtml(taxon.canonicalScientificName)}</i> · ${escapeHtml(taxon.family)} · Tier ${escapeHtml(taxon.tier)}</span></li>`).join("")}</ul>`
    : "<p>No new taxa. All 80 species remain eligible for cumulative certification work.</p>";
  const sessionsMarkup = module.sessions.map((session) => {
    const route = routeForCatalogSession(module, session);
    const complete = state.completedRoutes.includes(route);
    return `
      <article class="course-sequence-card">
        <span>Session ${escapeHtml(session.letter)} · ${complete ? "complete" : "not complete"}</span>
        <h3>${escapeHtml(session.title)}</h3>
        <p>${escapeHtml(session.delivery)}</p>
        <p class="course-meta-line">${session.modalities.map(formatToken).map(escapeHtml).join(" · ")}</p>
        <button class="course-link-button js-route" type="button" data-route="${escapeHtml(route)}">Open Session ${escapeHtml(session.letter)}</button>
      </article>
    `;
  }).join("");
  const assessmentMarkup = module.assessments.map((assessment) => {
    const modalitySummary = Object.entries(assessment.primaryModalityCounts)
      .map(([modality, count]) => `${formatToken(modality)} ${count}`)
      .join(" · ");
    const evidenceMinimums = assessment.minimumSpeciesSupportedStations
      ? ` · at least ${assessment.minimumSpeciesSupportedStations} species-supported, ${assessment.minimumLimitedEvidenceStations} evidence-limit, and ${assessment.minimumConfuserStations} direct-confuser stations`
      : "";
    const visualCount = Object.values(assessment.primaryModalityCounts).reduce((sum, value) => sum + Number(value), 0);
    const formLabel = visualCount === assessment.stationCount
      ? "visual"
      : visualCount > 0
        ? "mixed"
        : "nonvisual";
    const formal = state.formalAssessments[assessment.assessmentId];
    const status = formalAssessmentComplete(formal)
      ? "complete"
      : Number(formal?.submittedItems || 0) > 0
        ? `${formal.submittedItems}/${formal.totalItems} submitted`
        : "not started";
    const launch = `<button class="course-link-button js-route" type="button" data-route="formal/${escapeHtml(assessment.assessmentId)}">Open secure ${formLabel} form</button>`;
    return `<li><strong>${escapeHtml(assessment.assessmentId)}<small class="course-assessment-status">${escapeHtml(status)}</small></strong><span>${escapeHtml(formatToken(assessment.type))} · ${assessment.stationCount} prompts · ${assessment.timeGuidanceMinutes} minutes${modalitySummary ? ` · ${escapeHtml(modalitySummary)}` : ""}${escapeHtml(evidenceMinimums)}</span>${launch}</li>`;
  }).join("");
  const confuserMarkup = module.confuserSets.map((confuser) => `
    <details class="course-confuser-card">
      <summary><strong>${escapeHtml(confuser.confusionSetId)}</strong> · ${escapeHtml(confuser.name)}</summary>
      <p><strong>Separators:</strong> ${escapeHtml(confuser.keySeparators)}</p>
      <p><strong>Request if unresolved:</strong> ${escapeHtml(confuser.additionalViews)}</p>
    </details>
  `).join("");

  view.innerHTML = `
    ${pageHeader(
      `Week ${module.sequence} briefing · ${progress.completed}/${progress.total} complete`,
      module.title,
      `${module.newTaxa.length} new taxa; ${module.cumulativeEligibleTaxa} taxa remain eligible for retrieval. Pace may vary, but the field-identification standard does not.`
    )}
    <p class="course-notice"><strong>How this week works:</strong> complete the five instructional sessions, then open each secure assessment. Study and practice progress saves on this device and synchronizes after email sign-in; formal results enter the persistent gradebook.</p>
    <div class="course-brief-grid">
      <section class="course-panel"><h2>Learning objectives</h2><ol>${module.objectives.map((objective) => `<li>${escapeHtml(objective)}</li>`).join("")}</ol></section>
      <section class="course-panel"><h2>Expected silvics retrieval</h2><p>${escapeHtml(module.silvics.responseStandard)}</p><ul>${module.silvics.dimensions.map((dimension) => `<li>${escapeHtml(formatToken(dimension))}</li>`).join("")}</ul></section>
    </div>
    <section class="course-module-section"><div class="course-section-heading"><p class="course-kicker">Roster</p><h2>Species introduced</h2></div>${taxaMarkup}</section>
    <section class="course-module-section"><div class="course-section-heading"><p class="course-kicker">Instruction</p><h2>Five-session sequence</h2></div><div class="course-sequence-grid">${sessionsMarkup}</div></section>
    <section class="course-module-section"><div class="course-section-heading"><p class="course-kicker">Discrimination</p><h2>Cumulative confuser sets</h2></div><div class="course-confuser-grid">${confuserMarkup}</div></section>
    <section class="course-module-section"><div class="course-section-heading"><p class="course-kicker">Graded work</p><h2>Scheduled assessments</h2></div><ul class="course-assessment-list">${assessmentMarkup}</ul></section>
    <div class="course-actions">
      <button class="course-link-button js-route" type="button" data-route="dashboard">Return to curriculum map</button>
      <button class="course-button ${briefingComplete ? "js-route" : "js-complete-route"}" type="button" ${briefingComplete ? "" : `data-completion-route="${escapeHtml(module.moduleId)}"`} data-route="${escapeHtml(firstSessionRoute)}">${briefingComplete ? "Briefing complete · open Session A" : "Complete briefing and open Session A"}</button>
    </div>
  `;
}

async function loadTeachingPackage(moduleId) {
  if (teachingPackages.has(moduleId)) return teachingPackages.get(moduleId);
  const base = (app.dataset.teachingBaseUrl || "/assets/course/data/teaching").replace(/\/$/, "");
  const response = await fetch(`${base}/${moduleId}.json`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${moduleId} teaching package request failed (${response.status})`);
  const payload = await response.json();
  if (payload.moduleId !== moduleId || payload.$schema !== "cochetopa-public-teaching-package/1.0") {
    throw new Error(`${moduleId} teaching package failed its public schema check`);
  }
  teachingPackages.set(moduleId, payload);
  return payload;
}

function teachingProfileCard(profile, index) {
  const diagnostics = Object.entries(profile.fieldIdentification)
    .filter(([field]) => !["variationAndCondition", "defensibilityLimits"].includes(field))
    .map(([field, content]) => `<div><h3>${escapeHtml(formatCamelToken(field))}</h3><p>${escapeHtml(content)}</p></div>`)
    .join("");
  const confusers = profile.confuserControl.map((confuser) => `
    <details class="course-confuser-card">
      <summary><strong>Versus <i>${escapeHtml(confuser.confuser)}</i></strong></summary>
      <p><strong>Visible separator:</strong> ${escapeHtml(confuser.visibleSeparators)}</p>
      <p><strong>Request if unresolved:</strong> ${escapeHtml(confuser.resolvingView)}</p>
    </details>
  `).join("");
  const silvics = Object.entries(profile.silvicsCapsule)
    .map(([field, content]) => `<div><dt>${escapeHtml(formatCamelToken(field))}</dt><dd>${escapeHtml(content)}</dd></div>`)
    .join("");
  const references = profile.references.map((reference) => `
    <li><a href="${escapeHtml(reference.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reference.title)}</a><span>${escapeHtml(reference.scope)}</span></li>
  `).join("");

  return `
    <details class="course-species-card" ${index === 0 ? "open" : ""}>
      <summary><h2 class="course-species-card__name">${escapeHtml(profile.preferredCommonName)}<span><i>${escapeHtml(profile.canonicalScientificName)}</i> · ${escapeHtml(profile.family)} · Tier ${escapeHtml(profile.tier)}</span></h2></summary>
      <div class="course-species-card__body course-teaching-profile">
        <div class="course-profile-context">
          <p><strong>Regional role:</strong> ${escapeHtml(profile.distributionInCourseRegion)}</p>
          <p><strong>Ecological importance:</strong> ${escapeHtml(profile.ecologicalImportance)}</p>
          ${profile.acceptedAlternatives.length ? `<p><strong>Accepted alternatives:</strong> ${profile.acceptedAlternatives.map((name) => `<i>${escapeHtml(name)}</i>`).join("; ")}</p>` : ""}
        </div>
        <p class="course-evidence-limit"><strong>Maximum-evidence warning:</strong> ${escapeHtml(profile.fieldIdentification.defensibilityLimits)}</p>
        ${teachingMediaMarkup(profile)}
        <div class="course-species-facts">${diagnostics}</div>
        <section class="course-profile-section"><h3>Variation and condition</h3><p>${escapeHtml(profile.fieldIdentification.variationAndCondition)}</p></section>
        <section class="course-profile-section"><h3>Direct confuser control</h3><div class="course-confuser-grid">${confusers}</div></section>
        <details class="course-profile-disclosure"><summary>Forester’s silvics capsule</summary><dl class="course-silvics-grid">${silvics}</dl></details>
        <details class="course-profile-disclosure"><summary>Authoritative references</summary><ul class="course-reference-list">${references}</ul></details>
      </div>
    </details>
  `;
}

function practiceScopeTaxa(module, session) {
  const introduced = session.introducedTaxonIds || module.introducedTaxonIds || [];
  if (["B", "D", "E"].includes(session.letter) || !introduced.length) {
    return courseCatalog.modules
      .filter((candidate) => candidate.sequence <= module.sequence)
      .flatMap((candidate) => candidate.newTaxa.map((taxon) => taxon.taxonId));
  }
  return introduced;
}

function practiceItems(module, session, count = 6) {
  const route = `${module.moduleId}/session-${session.letter.toLowerCase()}`;
  const scope = new Set(practiceScopeTaxa(module, session));
  const candidates = publicMedia.media
    .filter((item) => item.pool === "practice" && scope.has(item.taxonId))
    .sort((left, right) => stableNumber(`${route}|${left.mediaId}`) - stableNumber(`${route}|${right.mediaId}`));
  const chosen = [];
  const taxa = new Set();
  const modalities = new Set();
  for (const item of candidates) {
    if (chosen.length >= count) break;
    if (!taxa.has(item.taxonId) && !modalities.has(item.primaryModality)) {
      chosen.push(item);
      taxa.add(item.taxonId);
      modalities.add(item.primaryModality);
    }
  }
  for (const item of candidates) {
    if (chosen.length >= count) break;
    if (!taxa.has(item.taxonId)) {
      chosen.push(item);
      taxa.add(item.taxonId);
      modalities.add(item.primaryModality);
    }
  }
  for (const item of candidates) {
    if (chosen.length >= count) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen;
}

function practiceFeedback(item, response) {
  const correct = matchesAnswer(response.identity, item.acceptedPracticeAnswers);
  const expected = item.answerCeiling === "species"
    ? `${item.preferredCommonName} — ${item.canonicalScientificName}`
    : `A ${formatToken(item.answerCeiling)}-level answer; accepted here: ${item.acceptedPracticeAnswers.join(" / ")}`;
  return `
    <div class="course-feedback ${correct ? "course-feedback--correct" : "course-feedback--incorrect"}">
      <p><strong>${correct ? "Identity accepted" : "Identity not accepted"}.</strong> ${escapeHtml(expected)}</p>
      <p><strong>Visible diagnostic basis:</strong> ${escapeHtml(item.visibleEvidence || "Use the profile’s organ-specific separators and do not exceed the reviewed evidence ceiling.")}</p>
      <p><strong>Nearest plausible alternative:</strong> ${escapeHtml(item.nearestPlausibleAlternative || "State the most plausible regional confuser.")}</p>
      <p><strong>Best additional view:</strong> ${escapeHtml(item.bestRequestedNextView || "Request another independent organ or a closer diagnostic view.")}</p>
      <p><strong>Your calibration:</strong> ${escapeHtml(response.confidence || "not stated")} confidence; evidence: ${escapeHtml(response.evidence || "not stated")}; alternative: ${escapeHtml(response.alternative || "not stated")}; requested view: ${escapeHtml(response.requestedView || "not stated")}.</p>
    </div>
  `;
}

function publicPracticeLab(module, session) {
  const route = `${module.moduleId}/session-${session.letter.toLowerCase()}`;
  const sourceItems = practiceItems(module, session);
  const record = state.practiceSessions[route] || { submitted: false, responses: {}, score: null, itemOrder: [] };
  state.practiceSessions[route] = record;
  const items = itemsInAttemptOrder(sourceItems, record, (item) => item.mediaId);
  const stations = items.map((item, index) => {
    const response = record.responses[item.mediaId] || {};
    return `
      <fieldset class="course-question course-public-practice-station">
        <legend>Station ${index + 1} · ${escapeHtml(formatToken(item.primaryModality))}</legend>
        ${publicMediaImage(item, false)}
        <label>Common or scientific name<input name="identity:${escapeHtml(item.mediaId)}" value="${escapeHtml(response.identity || "")}" required ${record.submitted ? "disabled" : ""}></label>
        <label>Confidence <span class="course-optional">(optional)</span><select name="confidence:${escapeHtml(item.mediaId)}" ${record.submitted ? "disabled" : ""}><option value="">Not stated</option>${["low", "medium", "high"].map((value) => `<option value="${value}" ${response.confidence === value ? "selected" : ""}>${formatToken(value)}</option>`).join("")}</select></label>
        <label>Visible diagnostic evidence <span class="course-optional">(optional)</span><textarea name="evidence:${escapeHtml(item.mediaId)}" ${record.submitted ? "disabled" : ""}>${escapeHtml(response.evidence || "")}</textarea></label>
        <label>Nearest plausible alternative <span class="course-optional">(optional)</span><input name="alternative:${escapeHtml(item.mediaId)}" value="${escapeHtml(response.alternative || "")}" ${record.submitted ? "disabled" : ""}></label>
        <label>Best additional view if uncertain <span class="course-optional">(optional)</span><input name="requestedView:${escapeHtml(item.mediaId)}" value="${escapeHtml(response.requestedView || "")}" ${record.submitted ? "disabled" : ""}></label>
        ${record.submitted ? practiceFeedback(item, response) : ""}
      </fieldset>
    `;
  }).join("");
  return `
    <section class="course-module-section course-practice-lab">
      <div class="course-section-heading"><p class="course-kicker">Unfamiliar retrieval</p><h2>Field-decision practice</h2></div>
      <p class="course-notice">Enter either a common name or scientific name for each specimen. That is enough to submit and grade the identification. Confidence and field-reasoning fields are optional; use them when you want deeper calibration. Item order is shuffled for each new attempt and remains fixed while that attempt is in progress. These specimens do not occur in the 558-station formal examination bank.</p>
      ${record.submitted ? `<p class="course-score-banner"><strong>Identity decisions: ${record.score}/${items.length} accepted.</strong> Diagnostic reasoning remains part of the field standard even when the name is correct.</p>` : ""}
      <form class="course-form js-public-practice" data-route="${escapeHtml(route)}">${stations}<div class="course-actions">${record.submitted ? '<button class="course-link-button js-reset-practice" type="button">Retry with a new shuffle</button>' : '<button class="course-button" type="submit">Submit field decisions</button>'}</div></form>
    </section>
  `;
}

function renderTeachingSession(module, session) {
  const profiles = session.teachingProfiles || [];
  const sessionIndex = module.sessions.findIndex((candidate) => candidate.sessionId === session.sessionId);
  const route = `${module.moduleId}/session-${session.letter.toLowerCase()}`;
  const previousRoute = sessionIndex > 0
    ? `${module.moduleId}/session-${module.sessions[sessionIndex - 1].letter.toLowerCase()}`
    : module.moduleId;
  const nextRoute = sessionIndex < module.sessions.length - 1
    ? `${module.moduleId}/session-${module.sessions[sessionIndex + 1].letter.toLowerCase()}`
    : module.assessments.length
      ? `formal/${encodeURIComponent(module.assessments[0].assessmentId)}`
      : module.moduleId;
  const routeComplete = state.completedRoutes.includes(route);
  const profileMarkup = profiles.length
    ? `<section class="course-species-grid" aria-label="Session ${escapeHtml(session.letter)} teaching profiles">${profiles.map(teachingProfileCard).join("")}</section>`
    : publicPracticeLab(module, session);
  const confuserMarkup = module.confuserSets.map((confuser) => `
    <details class="course-confuser-card">
      <summary><strong>${escapeHtml(confuser.confusionSetId)}</strong> · ${escapeHtml(confuser.name)}</summary>
      <p><strong>Visible separators:</strong> ${escapeHtml(confuser.keySeparators)}</p>
      <p><strong>Request if unresolved:</strong> ${escapeHtml(confuser.resolvingViews)}</p>
    </details>
  `).join("");

  view.innerHTML = `
    ${pageHeader(
      `Week ${module.sequence} · Session ${session.letter}${routeComplete ? " · complete" : ""}`,
      session.title,
      `${session.delivery}. Primary evidence: ${session.modalities.map(formatToken).join(", ")}.`
    )}
    <p class="course-notice"><strong>Field standard:</strong> name the narrowest defensible identity, state the nearest plausible alternative, cite the visible separator, and request the highest-value additional view when the evidence is incomplete.</p>
    ${profileMarkup}
    ${profiles.length && ["A", "C"].includes(session.letter) ? publicPracticeLab(module, session) : ""}
    <section class="course-module-section"><div class="course-section-heading"><p class="course-kicker">Cumulative discrimination</p><h2>Confuser controls still in force</h2></div><div class="course-confuser-grid">${confuserMarkup}</div></section>
    <div class="course-actions">
      <button class="course-link-button js-route" type="button" data-route="${escapeHtml(previousRoute)}">${sessionIndex > 0 ? "Previous session" : "Week briefing"}</button>
      <button class="course-button ${routeComplete ? "js-route" : "js-complete-route"}" type="button" ${routeComplete ? "" : `data-completion-route="${escapeHtml(route)}"`} data-route="${escapeHtml(nextRoute)}">${routeComplete ? (sessionIndex < module.sessions.length - 1 ? "Next session" : "Open weekly assessment") : `Complete Session ${session.letter} and continue`}</button>
    </div>
  `;
}

function assessmentCatalogRecord(assessmentId) {
  for (const module of courseCatalog.modules) {
    const assessment = module.assessments.find((candidate) => candidate.assessmentId === assessmentId);
    if (assessment) return { module, assessment };
  }
  return null;
}

async function renderFormalAssessment(assessmentId) {
  const record = assessmentCatalogRecord(assessmentId);
  if (!record) {
    renderNotFound();
    return;
  }
  const auth = window.cochetopaAuth;
  if (!auth) {
    view.innerHTML = `${pageHeader("Secure assessment", assessmentId, "Checking the passwordless course session…")}<p class="course-notice">The account service is still initializing.</p>`;
    return;
  }
  if (!auth.enabled) {
    view.innerHTML = `${pageHeader(`Week ${record.module.sequence} · secure assessment`, assessmentId, `${record.assessment.stationCount} prompts · ${record.assessment.timeGuidanceMinutes} minutes.`)}<p class="course-notice"><strong>Account service unavailable:</strong> secure assessments require the passwordless course account. Your instructional progress remains saved on this device; please try the assessment again shortly.</p><div class="course-actions"><button class="course-link-button js-route" type="button" data-route="${escapeHtml(record.module.moduleId)}">Return to week plan</button></div>`;
    return;
  }
  if (!auth.signedIn()) {
    view.innerHTML = `${pageHeader(`Week ${record.module.sequence} · secure assessment`, assessmentId, "Passwordless sign-in is required so the form can remain fixed, resumable, and unfamiliar.")}<p class="course-notice">Enter your email in the account panel and return from the one-time link. No password is required.</p><div class="course-actions"><button class="course-link-button js-route" type="button" data-route="${escapeHtml(record.module.moduleId)}">Return to week plan</button></div>`;
    return;
  }
  view.innerHTML = `${pageHeader("Secure assessment", assessmentId, "Assembling your persisted unfamiliar form…")}<div class="course-loading" role="status">Contacting the private assessment service…</div>`;
  try {
    let form = formalForms.get(assessmentId);
    if (!form) {
      form = await auth.createOrResumeFormal(assessmentId);
      formalForms.set(assessmentId, form);
    }
    rememberFormalForm(form);
    const visualItems = form.stations || [];
    const nonvisualItems = form.items || [];
    const pendingVisual = visualItems.find((station) => !station.submitted);
    const pendingNonvisual = nonvisualItems.find((item) => !item.submitted);
    const totalItems = visualItems.length + nonvisualItems.length;
    const submittedItems = visualItems.filter((item) => item.submitted).length + nonvisualItems.filter((item) => item.submitted).length;
    if (!pendingVisual && !pendingNonvisual) {
      const reviewMessage = form.status === "completed"
        ? "This assessment is graded and locked in the course gradebook."
        : "Exact-name scoring is complete; any extended silvics answers are awaiting criterion-level review.";
      view.innerHTML = `${pageHeader("Secure assessment", assessmentId, "Every item has been submitted and locked.")}<p class="course-notice">${reviewMessage} Answer keys remain server-side until the form is finalized, and no submitted item can be replaced.</p><div class="course-actions"><button class="course-link-button js-route" type="button" data-route="${escapeHtml(record.module.moduleId)}">Return to week plan</button></div>`;
      return;
    }
    if (pendingVisual) {
      const imageUrl = auth.formalMediaUrl(pendingVisual.mediaToken);
      view.innerHTML = `
        ${pageHeader(`Secure assessment · Item ${submittedItems + 1} of ${totalItems}`, assessmentId, `Primary evidence: ${formatToken(pendingVisual.modality)}. Answer only at the narrowest rank justified by this view.`)}
        <form class="course-form js-formal-station" data-assessment-id="${escapeHtml(assessmentId)}" data-form-id="${escapeHtml(form.formId)}" data-part="visual" data-item="${pendingVisual.stationNumber}">
          <fieldset class="course-question course-public-practice-station">
            <legend>Locked unfamiliar visual station ${pendingVisual.stationNumber}</legend>
            <figure class="course-image-card course-formal-image"><img src="${escapeHtml(imageUrl)}" alt="Unlabeled ${escapeHtml(formatToken(pendingVisual.modality))} identification specimen" referrerpolicy="no-referrer"><figcaption>${escapeHtml(pendingVisual.attribution || "Rights-reviewed course specimen")} · ${escapeHtml(pendingVisual.licenseCode || "licensed source")}</figcaption></figure>
            <label>Common or scientific name<input name="identity" required autocomplete="off"></label>
            <label>Confidence <span class="course-optional">(optional)</span><select name="confidence"><option value="">Not stated</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
            <label>Visible diagnostic evidence <span class="course-optional">(optional)</span><textarea name="visibleEvidence"></textarea></label>
            <label>Nearest plausible alternative <span class="course-optional">(optional)</span><input name="nearestAlternative"></label>
            <label>Best additional view if uncertain <span class="course-optional">(optional)</span><input name="requestedView"></label>
          </fieldset>
          <p class="course-notice">A common or scientific name is enough to submit and grade this station. The optional fields support reflection but do not change the identification score. The secure form was shuffled when it was assembled and keeps that order when resumed. Submission locks the station; feedback and answer keys remain withheld until the complete form is finalized.</p>
          <div class="course-actions"><button class="course-button" type="submit">Submit and lock item</button></div>
        </form>`;
    } else {
      const extended = pendingNonvisual.responseSchema?.type === "extended_text";
      const answerControl = extended
        ? '<textarea name="answer" rows="9" required autocomplete="off"></textarea>'
        : '<input name="answer" required autocomplete="off">';
      view.innerHTML = `
        ${pageHeader(`Secure assessment · Item ${submittedItems + 1} of ${totalItems}`, assessmentId, `${pendingNonvisual.pointValue} point${Number(pendingNonvisual.pointValue) === 1 ? "" : "s"} · answer from memory without outside references.`)}
        <form class="course-form js-formal-station" data-assessment-id="${escapeHtml(assessmentId)}" data-form-id="${escapeHtml(form.formId)}" data-part="nonvisual" data-item="${pendingNonvisual.itemNumber}">
          <fieldset class="course-question">
            <legend>Locked cumulative retrieval item ${pendingNonvisual.itemNumber}</legend>
            <p class="course-formal-prompt">${escapeHtml(pendingNonvisual.prompt)}</p>
            <label>Your answer${answerControl}</label>
            <label>Confidence <span class="course-optional">(optional)</span><select name="confidence"><option value="">Not stated</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </fieldset>
          <p class="course-notice">Scientific names are exact-match scored after normalization. Extended silvics and reasoning responses use the private criterion rubric and remain pending until reviewed.</p>
          <div class="course-actions"><button class="course-button" type="submit">Submit and lock item</button></div>
        </form>`;
    }
  } catch (error) {
    view.innerHTML = `${pageHeader("Secure assessment unavailable", assessmentId, "The private form could not be opened.")}<p class="course-notice">${escapeHtml(error.message)}</p><div class="course-actions"><button class="course-link-button js-route" type="button" data-route="${escapeHtml(record.module.moduleId)}">Return to week plan</button></div>`;
  }
}

function licenseDetails(attribution = "") {
  if (/CC BY-SA/i.test(attribution)) {
    return { label: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" };
  }
  if (/CC BY/i.test(attribution)) {
    return { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" };
  }
  return { label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
}

function attributionMarkup(image, label = "Image") {
  const license = licenseDetails(image.attribution);
  return `<span class="course-attribution">${escapeHtml(label)} credit: ${escapeHtml(image.attribution)} · <a href="${escapeHtml(image.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a> · <a href="${license.url}" target="_blank" rel="license noopener noreferrer">${license.label}</a></span>`;
}

function renderWeekBriefing() {
  view.innerHTML = `
    ${pageHeader(
      "Week 1 briefing",
      course.week.title,
      "The opening week establishes a repeatable field-decision process while introducing nine anchor species that structure northern-hardwood reasoning."
    )}
    <div class="course-brief-grid">
      <section class="course-panel"><h2>Learning objectives</h2><ol>${course.week.objectives.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>
      <section class="course-panel"><h2>Initial confuser sets</h2><ul>${course.week.confusers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
      <section class="course-panel"><h2>Species introduced</h2><ul>${course.species.map((species) => `<li>${escapeHtml(species.commonName)} — <i>${escapeHtml(species.scientificName)}</i></li>`).join("")}</ul></section>
      <section class="course-panel"><h2>Assessment sequence</h2><ol><li>Study multiple views in Session A.</li><li>Retrieve nine species from unfamiliar specimens in Session B.</li><li>Resolve direct confuser decisions in Session C.</li><li>Work another unfamiliar multi-organ set in Session D.</li><li>Complete identity, bidirectional nomenclature, and open-response silvics retrieval in Session E.</li><li>Finish the twelve-item practical rehearsal.</li></ol></section>
    </div>
    <p class="course-notice">Teaching images can explain a species but cannot prove that you recognize another individual. None of the Session A photographs appears in the visual retrieval lab.</p>
    ${completionButton("briefing", "week-01/session-a", "Complete briefing and open Session A")}
  `;
}

function imageCard(image) {
  return `
    <figure class="course-image-card">
      <button class="course-zoom-button js-zoom" type="button" aria-label="Enlarge ${escapeHtml(image.alt)}" data-src="${escapeHtml(image.src)}" data-alt="${escapeHtml(image.alt)}" data-caption="${escapeHtml(image.caption)}" data-attribution="${escapeHtml(image.attribution)}" data-source-url="${escapeHtml(image.sourceUrl)}">
        <img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" loading="lazy" />
      </button>
      <figcaption><strong>${escapeHtml(image.view)}</strong>${escapeHtml(image.caption)}${attributionMarkup(image)}</figcaption>
    </figure>
  `;
}

function speciesCard(species, index) {
  return `
    <details class="course-species-card" ${index === 0 ? "open" : ""}>
      <summary><h2 class="course-species-card__name">${escapeHtml(species.commonName)}<span><i>${escapeHtml(species.scientificName)}</i> · ${escapeHtml(species.family)}</span></h2></summary>
      <div class="course-species-card__body">
        <div class="course-image-grid">${species.images.map(imageCard).join("")}</div>
        <div class="course-species-facts">
          <div><h3>Fast field call</h3><p>${escapeHtml(species.fastCall)}</p></div>
          <div><h3>Other organs</h3><p>${escapeHtml(species.otherOrgans)}</p></div>
          <div><h3>Variation warning</h3><p>${escapeHtml(species.variation)}</p></div>
          <div><h3>Nearest alternatives</h3><p>${escapeHtml(species.confusers)}</p></div>
          <div><h3>Silvics capsule</h3><p>${escapeHtml(species.silvics)}</p></div>
        </div>
      </div>
    </details>
  `;
}

function renderSessionA() {
  view.innerHTML = `
    ${pageHeader(
      "Session A",
      "Evidence Before Identity",
      "Use the same evidence order on every specimen. Habitat changes what is plausible; it does not replace diagnostic morphology."
    )}
    <section class="course-evidence-steps" aria-label="Field decision sequence">${course.fieldDecisionSteps.map((step) => `<article class="course-evidence-step"><p>${escapeHtml(step)}</p></article>`).join("")}</section>
    <p class="course-notice"><strong>Bark is an age series.</strong> A sapling, pole, mature tree, and old tree of one species may look less alike than two species of the same age.</p>
    <section class="course-species-grid" aria-label="Anchor species profiles">${course.species.map(speciesCard).join("")}</section>
    ${completionButton("session-a", "week-01/visual-lab", "Complete Session A and begin retrieval")}
  `;
}

function responseFor(assessmentKey, itemId) {
  const assessment = state.assessments[assessmentKey];
  assessment.responses[itemId] ||= {
    commonName: "",
    scientificName: "",
    answer: "",
    confidence: "",
    evidence: "",
    alternative: "",
  };
  return assessment.responses[itemId];
}

function confidenceOptions(includeInsufficientEvidence) {
  const options = [
    ["C1", "C1 — tentative"],
    ["C2", "C2 — moderately confident"],
    ["C3", "C3 — highly confident"],
  ];
  if (includeInsufficientEvidence) options.push(["IE", "IE — requested rank is unsupported"]);
  return options;
}

function confidenceSelectOptions(selected, includeInsufficientEvidence) {
  return confidenceOptions(includeInsufficientEvidence)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function isInsufficientAnswer(value) {
  return ["insufficient evidence", "insufficient", "cannot determine"].includes(normalizeAnswer(value));
}

function identityEvaluation(item, response) {
  const commonProvided = Boolean(String(response.commonName || "").trim());
  const scientificProvided = Boolean(String(response.scientificName || "").trim());
  const commonIE = isInsufficientAnswer(response.commonName);
  const scientificIE = isInsufficientAnswer(response.scientificName);
  const acceptsIE = item.commonAnswers.some(isInsufficientAnswer) && item.scientificAnswers.some(isInsufficientAnswer);
  if (!commonProvided && !scientificProvided) {
    return {
      commonCorrect: false,
      scientificCorrect: false,
      identityCorrect: false,
      coherent: false,
    };
  }
  if (commonIE || scientificIE) {
    const coherent = (!commonProvided || commonIE) && (!scientificProvided || scientificIE);
    const identityCorrect = coherent && acceptsIE;
    return {
      commonCorrect: commonProvided && commonIE && acceptsIE,
      scientificCorrect: scientificProvided && scientificIE && acceptsIE,
      identityCorrect,
      coherent,
    };
  }
  const commonAccepted = !commonProvided || matchesAnswer(response.commonName, item.commonAnswers);
  const scientificAccepted = !scientificProvided || matchesAnswer(response.scientificName, item.scientificAnswers);
  return {
    commonCorrect: commonProvided && commonAccepted,
    scientificCorrect: scientificProvided && scientificAccepted,
    identityCorrect: commonAccepted && scientificAccepted,
    coherent: true,
  };
}

function calibrationMessage(correct, confidence, permitsInsufficientEvidence = false, autoGradable = true) {
  if (!autoGradable) {
    return `You chose ${confidence || "no confidence code"}. Compare the completeness of your response with the reference rubric; this open response is not auto-judged.`;
  }
  if (confidence === "C3" && !correct) {
    return "Calibration flag: this was a confidently wrong response and should return quickly in remediation.";
  }
  if (confidence === "IE") {
    return correct && permitsInsufficientEvidence
      ? "Calibration: you correctly stopped at the evidence limit."
      : "Calibration flag: IE is appropriate only when the requested identity rank is not defensible from the evidence.";
  }
  if (correct && confidence === "C1") return "Calibration: correct but tentative; retrieve it again from a different organ.";
  if (correct && confidence === "C3") return "Calibration: correct with high confidence; future repetitions can widen in spacing.";
  return "Calibration: compare your confidence with the revealed evidence before the next retrieval.";
}

function shortFieldMarkup(assessmentKey, item, index) {
  const assessment = state.assessments[assessmentKey];
  const response = responseFor(assessmentKey, item.id);
  const disabled = assessment.submitted ? "disabled" : "";
  const autoGradable = item.autoGrade !== false;
  const correct = assessment.submitted && autoGradable && matchesAnswer(response.answer, item.answers || []);
  const fieldId = `${assessmentKey}-${item.id}-answer`;
  const answerField = item.multiline
    ? `<textarea id="${fieldId}" name="answer" ${disabled} required>${escapeHtml(response.answer)}</textarea>`
    : `<input id="${fieldId}" name="answer" value="${escapeHtml(response.answer)}" ${disabled} required autocomplete="off" autocapitalize="off" spellcheck="false" />`;
  const result = assessment.submitted
    ? `<div class="course-result ${correct ? "course-result--correct" : "course-result--review"}">
        <h3>${autoGradable ? (correct ? "Answer correct" : "Review the answer") : "Compare with the reference rubric"}</h3>
        <p><strong>Course answer:</strong> ${escapeHtml(item.courseAnswer || (item.answers || [""])[0])}</p>
        <p><strong>Reference rubric:</strong> ${escapeHtml(item.referenceEvidence)}</p>
        ${item.nearestAlternative ? `<p><strong>Important contrast:</strong> ${escapeHtml(item.nearestAlternative)}</p>` : ""}
        <p><strong>Confidence check:</strong> ${escapeHtml(calibrationMessage(correct, response.confidence, false, autoGradable))}</p>
      </div>`
    : "";

  return `
    <article class="course-question" data-item-id="${escapeHtml(item.id)}">
      <h2 class="course-question__number">Item ${index + 1}</h2>
      <p class="course-question__prompt">${escapeHtml(item.prompt)}</p>
      <div class="course-form-grid">
        <div class="course-field ${item.multiline ? "course-field--wide" : ""}"><label for="${fieldId}">${escapeHtml(item.answerLabel || "Answer")}</label>${answerField}</div>
        <div class="course-field"><label for="${assessmentKey}-${item.id}-confidence">Confidence <span class="course-optional">(optional)</span></label><select id="${assessmentKey}-${item.id}-confidence" name="confidence" ${disabled}><option value="">Not stated</option>${confidenceSelectOptions(response.confidence, false)}</select></div>
      </div>
      ${result}
    </article>
  `;
}

function fieldMarkup(assessmentKey, item, index, includeImage) {
  if (item.responseType === "short") return shortFieldMarkup(assessmentKey, item, index);
  const assessment = state.assessments[assessmentKey];
  const response = responseFor(assessmentKey, item.id);
  const disabled = assessment.submitted ? "disabled" : "";
  const evaluation = identityEvaluation(item, response);

  const image = includeImage
    ? `<figure class="course-question__figure"><button class="course-zoom-button js-zoom" type="button" aria-label="Enlarge unfamiliar practice image ${index + 1}" data-src="${escapeHtml(item.image.src)}" data-alt="${escapeHtml(item.image.alt)}" data-caption="Unfamiliar practice image ${index + 1}" data-attribution="${escapeHtml(item.image.attribution)}" data-source-url="${escapeHtml(item.image.sourceUrl)}"><img class="course-question__image" src="${escapeHtml(item.image.src)}" alt="${escapeHtml(item.image.alt)}" loading="lazy" /></button><figcaption>${attributionMarkup(item.image, "Photo")}</figcaption></figure>`
    : "";

  const result = assessment.submitted
    ? `<div class="course-result ${evaluation.identityCorrect ? "course-result--correct" : "course-result--review"}">
        <h3>${evaluation.identityCorrect ? "Identity correct" : "Review the identity"}</h3>
        <p><strong>Course answer:</strong> ${escapeHtml(item.commonAnswers[0])} — <i>${escapeHtml(item.scientificAnswers[0])}</i></p>
        <p><strong>Diagnostic evidence:</strong> ${escapeHtml(item.referenceEvidence)}</p>
        <p><strong>Nearest alternative / requested view:</strong> ${escapeHtml(item.nearestAlternative)}</p>
        ${!evaluation.coherent ? "<p><strong>Answer check:</strong> If both name fields are used, they must describe the same identity decision.</p>" : ""}
        <p><strong>Confidence check:</strong> ${escapeHtml(calibrationMessage(evaluation.identityCorrect, response.confidence, item.commonAnswers.some(isInsufficientAnswer)))}</p>
      </div>`
    : "";

  return `
    <article class="course-question" data-item-id="${escapeHtml(item.id)}">
      <h2 class="course-question__number">Item ${index + 1}</h2>
      ${image}
      ${item.prompt ? `<p class="course-question__prompt">${escapeHtml(item.prompt)}</p>` : ""}
      <div class="course-form-grid" data-identity-pair>
        <p class="course-field-note course-field--wide">Enter either the preferred common name or the scientific name. One correct name is enough for identity credit.</p>
        <div class="course-field"><label for="${assessmentKey}-${item.id}-common">Preferred common name</label><input id="${assessmentKey}-${item.id}-common" name="commonName" value="${escapeHtml(response.commonName)}" ${disabled} autocomplete="off" /></div>
        <div class="course-field"><label for="${assessmentKey}-${item.id}-scientific">Scientific name</label><input id="${assessmentKey}-${item.id}-scientific" name="scientificName" value="${escapeHtml(response.scientificName)}" ${disabled} autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
        <div class="course-field"><label for="${assessmentKey}-${item.id}-confidence">Confidence / evidence limit <span class="course-optional">(optional)</span></label><select id="${assessmentKey}-${item.id}-confidence" name="confidence" ${disabled}><option value="">Not stated</option>${confidenceSelectOptions(response.confidence, true)}</select></div>
        <div class="course-field course-field--wide"><label for="${assessmentKey}-${item.id}-evidence">Strongest visible diagnostic evidence <span class="course-optional">(optional)</span></label><textarea id="${assessmentKey}-${item.id}-evidence" name="evidence" ${disabled}>${escapeHtml(response.evidence)}</textarea></div>
        <div class="course-field course-field--wide"><label for="${assessmentKey}-${item.id}-alternative">Nearest plausible alternative and separator, or requested view <span class="course-optional">(optional)</span></label><textarea id="${assessmentKey}-${item.id}-alternative" name="alternative" ${disabled}>${escapeHtml(response.alternative)}</textarea></div>
      </div>
      ${result}
    </article>
  `;
}

function assessmentScore(assessmentKey, items) {
  let score = 0;
  let maximum = 0;
  items.forEach((item) => {
    const response = responseFor(assessmentKey, item.id);
    if (item.responseType === "short") {
      if (item.autoGrade !== false) {
        maximum += 1;
        if (matchesAnswer(response.answer, item.answers || [])) score += 1;
      }
    } else {
      maximum += 1;
      const evaluation = identityEvaluation(item, response);
      if (evaluation.identityCorrect) score += 1;
    }
  });
  return { score, maximum };
}

function assessmentPage(assessmentKey, kicker, title, instructions, items, includeImages, activityId, nextRoute) {
  const assessment = state.assessments[assessmentKey];
  const displayedItems = itemsInAttemptOrder(items, assessment, (item) => item.id);
  const scoreMarkup = assessment.submitted
    ? `<p class="course-score">${assessment.maximumScore > 0 ? `Identifications: ${assessment.identityScore} of ${assessment.maximumScore} accepted. ` : ""}Optional evidence, alternatives, and confidence remain available for comparison with the revealed field rubric.</p>`
    : "";
  return `
    ${pageHeader(kicker, title, instructions)}
    <p class="course-notice">For identification items, enter either the preferred common name or the scientific name; one is enough to submit and receive identity credit. Confidence, visible evidence, and confuser reasoning are optional. Item order is shuffled once for this attempt and stays fixed through navigation or reloading. Answers remain hidden until the full batch is submitted. This practice batch supports retrieval and remediation; secure assessments determine the formal course grade.</p>
    <form class="course-form js-assessment" data-assessment="${assessmentKey}" data-activity="${activityId}">
      ${displayedItems.map((item, index) => fieldMarkup(assessmentKey, item, index, includeImages)).join("")}
      ${scoreMarkup}
      <div class="course-actions">
        ${assessment.submitted
          ? `<button class="course-button js-route" type="button" data-route="${nextRoute}">Continue</button>`
          : `<button class="course-button" type="submit">Submit the complete batch</button>`}
      </div>
    </form>
  `;
}

function renderVisualLab() {
  view.innerHTML = assessmentPage(
    "visualLab",
    "Session B",
    course.visualLab.title,
    course.visualLab.instructions,
    course.visualLab.items,
    true,
    "visual-lab",
    "week-01/confuser-lab"
  );
}

function renderConfuserLab() {
  view.innerHTML = assessmentPage(
    "confuserLab",
    "Session C",
    course.confuserLab.title,
    course.confuserLab.instructions,
    course.confuserLab.items,
    false,
    "confuser-lab",
    "week-01/multi-organ-lab"
  );
}

function renderMultiOrganLab() {
  view.innerHTML = assessmentPage(
    "multiOrganLab",
    "Session D",
    course.multiOrganLab.title,
    course.multiOrganLab.instructions,
    course.multiOrganLab.items,
    true,
    "multi-organ-lab",
    "week-01/checkpoint"
  );
}

function renderCheckpoint() {
  view.innerHTML = assessmentPage(
    "checkpoint",
    "Session E",
    course.checkpoint.title,
    course.checkpoint.instructions,
    course.checkpoint.items,
    false,
    "session-e-identity",
    firstMissingSessionERoute()
  );
}

function renderNomenclatureDrill() {
  view.innerHTML = assessmentPage(
    "nomenclatureDrill",
    "Session E · Names",
    course.nomenclatureDrill.title,
    course.nomenclatureDrill.instructions,
    course.nomenclatureDrill.items,
    false,
    "session-e-names",
    firstMissingSessionERoute()
  );
}

function renderSilvicsDrill() {
  view.innerHTML = assessmentPage(
    "silvicsDrill",
    "Session E · Silvics",
    course.silvicsDrill.title,
    course.silvicsDrill.instructions,
    course.silvicsDrill.items,
    false,
    "checkpoint",
    firstMissingSessionERoute()
  );
}

function renderWeeklyPractical() {
  view.innerHTML = assessmentPage(
    "weeklyPractical",
    "Weekly practical",
    course.weeklyPractical.title,
    course.weeklyPractical.instructions,
    course.weeklyPractical.items,
    true,
    "weekly-practical",
    "dashboard"
  );
}

function renderNotFound() {
  view.innerHTML = `<div class="course-error"><h1>Course page not found</h1><p>Return to the course dashboard.</p><button class="course-button js-route" type="button" data-route="dashboard">Course home</button></div>`;
}

async function renderReviewerQueue() {
  const auth = window.cochetopaAuth;
  if (!auth?.enabled || !auth.signedIn()) {
    view.innerHTML = `${pageHeader("Criterion review", "Instructor queue", "Sign in with an allowlisted reviewer email to open this protected page.")}<p class="course-notice">Learner accounts cannot see private rubrics, accepted answers, or this queue.</p>`;
    return;
  }
  try {
    const payload = await auth.getReviewQueue();
    const item = payload.queue?.[0];
    if (!item) {
      view.innerHTML = `${pageHeader("Criterion review", "Queue clear", "No submitted answers are waiting for review.")}<div class="course-actions"><button class="course-link-button js-route" type="button" data-route="dashboard">Course home</button></div>`;
      return;
    }
    const specimen = item.mediaUrl
      ? `<figure class="course-image-card course-formal-image"><img src="${escapeHtml(item.mediaUrl)}" alt="Private examination specimen for criterion review" referrerpolicy="no-referrer"><figcaption>${escapeHtml(item.attribution || "Rights-reviewed examination specimen")} · ${escapeHtml(item.licenseCode || "")}</figcaption></figure>`
      : "";
    view.innerHTML = `
      ${pageHeader("Criterion review", item.assessmentId, `${payload.queue.length} answer${payload.queue.length === 1 ? "" : "s"} waiting · ${formatToken(item.part)} item ${item.itemNumber}`)}
      <section class="course-panel course-review-panel">
        ${specimen}
        <h2>Learner response</h2>
        <pre class="course-review-json">${escapeHtml(JSON.stringify(item.response, null, 2))}</pre>
        <h2>Private criterion basis</h2>
        <pre class="course-review-json">${escapeHtml(JSON.stringify(item.privateRubric, null, 2))}</pre>
        <form class="course-form js-review-item" data-form-id="${escapeHtml(item.formId)}" data-part="${escapeHtml(item.part)}" data-item="${item.itemNumber}">
          <label>Points awarded, 0–${item.maximumPoints}<input type="number" name="awardedPoints" min="0" max="${item.maximumPoints}" step="0.25" required></label>
          <label>Auditable review notes<textarea name="reviewNotes" required></textarea></label>
          <div class="course-actions"><button class="course-button" type="submit">Record review and continue</button></div>
        </form>
      </section>`;
  } catch (error) {
    view.innerHTML = `${pageHeader("Criterion review unavailable", "Instructor queue", "This page is restricted to configured reviewers.")}<p class="course-notice">${escapeHtml(error.message)}</p>`;
  }
}

async function submitReviewerItem(form) {
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const response = Object.fromEntries(new FormData(form).entries());
  try {
    await window.cochetopaAuth.reviewFormalItem(
      form.dataset.formId,form.dataset.part,Number(form.dataset.item),
      Number(response.awardedPoints),response.reviewNotes,
    );
    await renderReviewerQueue();
    bindInteractiveElements();
  } catch (error) {
    button.disabled = false;
    const notice = document.createElement("p");
    notice.className = "course-notice";
    notice.textContent = error.message;
    form.prepend(notice);
  }
}

async function renderRoute() {
  const route = currentRoute();
  setActiveNavigation(route);
  const formalMatch = route.match(/^formal\/(.+)$/);
  if (formalMatch) {
    await renderFormalAssessment(decodeURIComponent(formalMatch[1]));
    if (currentRoute() !== route) return;
    bindInteractiveElements();
    updateProgress();
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "review") {
    await renderReviewerQueue();
    bindInteractiveElements();
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  const teachingSessionMatch = route.match(/^(week-(?:0[2-9]|10))\/session-([a-e])$/);
  if (teachingSessionMatch) {
    try {
      const module = await loadTeachingPackage(teachingSessionMatch[1]);
      const session = module.sessions.find((candidate) => candidate.letter.toLowerCase() === teachingSessionMatch[2]);
      if (!session) throw new Error(`${route} is absent from the teaching package`);
      if (currentRoute() !== route) return;
      renderTeachingSession(module, session);
    } catch (error) {
      view.innerHTML = `<div class="course-error"><h1>The teaching session could not load</h1><p>${escapeHtml(error.message)}</p><button class="course-link-button js-route" type="button" data-route="${escapeHtml(teachingSessionMatch[1])}">Return to the week plan</button></div>`;
    }
    bindInteractiveElements();
    updateProgress();
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  const catalogModule = courseCatalog.modules.find((module) => module.moduleId === route);
  if (catalogModule && catalogModule.sequence !== 1) {
    renderModuleOverview(catalogModule);
    bindInteractiveElements();
    updateProgress();
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return;
  }
  switch (route) {
    case "dashboard": renderDashboard(); break;
    case "week-01": renderWeekBriefing(); break;
    case "week-01/session-a": renderSessionA(); break;
    case "week-01/visual-lab": renderVisualLab(); break;
    case "week-01/confuser-lab": renderConfuserLab(); break;
    case "week-01/multi-organ-lab": renderMultiOrganLab(); break;
    case "week-01/checkpoint": renderCheckpoint(); break;
    case "week-01/session-e/nomenclature": renderNomenclatureDrill(); break;
    case "week-01/session-e/silvics": renderSilvicsDrill(); break;
    case "week-01/weekly-practical": renderWeeklyPractical(); break;
    default: renderNotFound();
  }
  bindInteractiveElements();
  updateProgress();
  view.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function updateIdentityPairValidity(pair) {
  const commonName = pair.querySelector('[name="commonName"]');
  const scientificName = pair.querySelector('[name="scientificName"]');
  if (!commonName || !scientificName || commonName.disabled || scientificName.disabled) return true;
  const hasIdentity = Boolean(commonName.value.trim() || scientificName.value.trim());
  const message = hasIdentity ? "" : "Enter either a preferred common name or a scientific name.";
  commonName.setCustomValidity(message);
  scientificName.setCustomValidity(message);
  return hasIdentity;
}

function validateAssessmentIdentities(form) {
  let valid = true;
  form.querySelectorAll("[data-identity-pair]").forEach((pair) => {
    if (!updateIdentityPairValidity(pair)) valid = false;
  });
  return valid;
}

function saveResponse(target) {
  const form = target.closest(".js-assessment");
  const question = target.closest(".course-question");
  if (!form || !question || !target.name) return;
  const assessment = state.assessments[form.dataset.assessment];
  if (assessment.submitted) return;
  const response = responseFor(form.dataset.assessment, question.dataset.itemId);
  response[target.name] = target.value;
  const identityPair = target.closest("[data-identity-pair]");
  if (identityPair) updateIdentityPairValidity(identityPair);
  saveState();
}

function submitAssessment(form) {
  validateAssessmentIdentities(form);
  if (!form.reportValidity()) return;
  const assessmentKey = form.dataset.assessment;
  const assessment = state.assessments[assessmentKey];
  const itemsByAssessment = {
    visualLab: course.visualLab.items,
    confuserLab: course.confuserLab.items,
    multiOrganLab: course.multiOrganLab.items,
    checkpoint: course.checkpoint.items,
    nomenclatureDrill: course.nomenclatureDrill.items,
    silvicsDrill: course.silvicsDrill.items,
    weeklyPractical: course.weeklyPractical.items,
  };
  const items = itemsByAssessment[assessmentKey];
  const score = assessmentScore(assessmentKey, items);
  assessment.identityScore = score.score;
  assessment.maximumScore = score.maximum;
  assessment.submitted = true;
  if (["checkpoint", "nomenclatureDrill", "silvicsDrill"].includes(assessmentKey)) {
    if (sessionEIsComplete() && !state.completed.includes("checkpoint")) {
      state.completed.push("checkpoint");
    }
  } else if (form.dataset.activity && !state.completed.includes(form.dataset.activity)) {
    state.completed.push(form.dataset.activity);
  }
  saveState();
  renderRoute();
}

function submitPublicPractice(form) {
  if (!form.reportValidity()) return;
  const route = form.dataset.route;
  const previous = state.practiceSessions[route] || {};
  const record = {
    submitted: true,
    responses: {},
    score: 0,
    itemOrder: Array.isArray(previous.itemOrder) ? [...previous.itemOrder] : [],
  };
  for (const [name, value] of new FormData(form).entries()) {
    const separator = name.indexOf(":");
    if (separator < 1) continue;
    const field = name.slice(0, separator);
    const mediaId = name.slice(separator + 1);
    record.responses[mediaId] ||= {};
    record.responses[mediaId][field] = String(value).trim();
  }
  for (const [mediaId, response] of Object.entries(record.responses)) {
    const item = mediaById.get(mediaId);
    if (item && matchesAnswer(response.identity, item.acceptedPracticeAnswers)) record.score += 1;
  }
  state.practiceSessions[route] = record;
  if (!state.completedRoutes.includes(route)) state.completedRoutes.push(route);
  saveState();
  renderRoute();
}

async function submitFormalStation(form) {
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "Locking station…";
  const response = Object.fromEntries(new FormData(form).entries());
  try {
    const part = form.dataset.part;
    const itemNumber = Number(form.dataset.item);
    const result = await window.cochetopaAuth.submitFormalItem(
      form.dataset.formId,
      part,
      itemNumber,
      response,
    );
    const stored = formalForms.get(form.dataset.assessmentId);
    const collection = part === "visual" ? stored?.stations : stored?.items;
    const item = collection?.find((candidate) =>
      part === "visual"
        ? candidate.stationNumber === itemNumber
        : candidate.itemNumber === itemNumber
    );
    if (item) item.submitted = true;
    if (stored && result.formStatus) stored.status = result.formStatus;
    if (stored) rememberFormalForm(stored);
    await refreshFormalTracking();
    await renderFormalAssessment(form.dataset.assessmentId);
    bindInteractiveElements();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Submit and lock item";
    const notice = document.createElement("p");
    notice.className = "course-notice";
    notice.textContent = error.message;
    form.prepend(notice);
  }
}

function openImage(button) {
  const image = imageDialog.querySelector("img");
  const caption = imageDialog.querySelector("#course-image-dialog-caption");
  const credit = imageDialog.querySelector("#course-image-dialog-credit");
  image.src = button.dataset.src;
  image.alt = button.dataset.alt;
  caption.textContent = button.dataset.caption || button.dataset.alt;
  if (button.dataset.sourceUrl) {
    credit.innerHTML = attributionMarkup(
      { attribution: button.dataset.attribution || "", sourceUrl: button.dataset.sourceUrl },
      "Photo"
    );
    credit.hidden = false;
  } else {
    credit.textContent = "";
    credit.hidden = true;
  }
  imageDialog.showModal();
}

function bindInteractiveElements() {
  view.querySelectorAll(".js-route").forEach((button) => button.addEventListener("click", () => go(button.dataset.route)));
  view.querySelectorAll(".js-complete").forEach((button) => button.addEventListener("click", () => {
    markComplete(button.dataset.activity);
    go(button.dataset.nextRoute);
  }));
  view.querySelectorAll(".js-complete-route").forEach((button) => button.addEventListener("click", () => {
    markRouteComplete(button.dataset.completionRoute);
    go(button.dataset.route);
  }));
  view.querySelectorAll(".js-zoom").forEach((button) => button.addEventListener("click", () => openImage(button)));
  view.querySelectorAll(".js-assessment").forEach((form) => {
    form.addEventListener("input", (event) => saveResponse(event.target));
    form.addEventListener("change", (event) => saveResponse(event.target));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAssessment(form);
    });
  });
  view.querySelectorAll(".js-public-practice").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitPublicPractice(form);
    });
  });
  view.querySelectorAll(".js-formal-station").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitFormalStation(form);
    });
  });
  view.querySelectorAll(".js-review-item").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitReviewerItem(form);
    });
  });
  view.querySelectorAll(".js-reset-practice").forEach((button) => {
    button.addEventListener("click", () => {
      const form = button.closest(".js-public-practice");
      if (!form) return;
      delete state.practiceSessions[form.dataset.route];
      state.completedRoutes = state.completedRoutes.filter((route) => route !== form.dataset.route);
      saveState();
      renderRoute();
    });
  });
  const resetButton = view.querySelector("#reset-course");
  if (resetButton) {
    resetButton.addEventListener("click", () => {
      if (window.confirm("Reset all study progress stored on this device? Secure assessment submissions remain in your signed-in course gradebook.")) {
        state = defaultState(course.courseVersion);
        saveState();
        renderRoute();
        void refreshFormalTracking({ rerender: true });
      }
    });
  }
}

function bindNavigation() {
  const desktopNavigation = document.querySelector("#course-nav");
  const moduleGroups = courseCatalog.modules.map((module) => {
    const links = moduleActivityRecords(module).map((activity) => `
      <button type="button" class="course-nav__link" data-route="${escapeHtml(activity.route)}" data-track-key="${escapeHtml(activity.key)}">
        <span class="course-nav__label">${escapeHtml(activity.label)}</span>
        <span class="course-nav__status" aria-hidden="true">${activity.complete ? "Complete" : ""}</span>
      </button>
    `).join("");
    const progress = moduleProgress(module);
    return `
      <details class="course-nav__week" data-module-id="${escapeHtml(module.moduleId)}">
        <summary>
          <span><strong>Week ${module.sequence}</strong><small>${escapeHtml(module.title)}</small></span>
          <span class="course-nav__week-progress">${progress.completed}/${progress.total}</span>
        </summary>
        <div class="course-nav__week-links">${links}</div>
      </details>
    `;
  }).join("");

  desktopNavigation.innerHTML = `
    <button type="button" class="course-nav__link course-nav__home" data-route="dashboard">Course home</button>
    <div class="course-nav__group">
      <p>Ten-week course</p>
      ${moduleGroups}
    </div>
  `;
  mobileMenu.innerHTML = desktopNavigation.innerHTML;
  document.querySelectorAll(".course-nav__link").forEach((button) => {
    button.addEventListener("click", () => {
      go(button.dataset.route);
      mobileMenu.hidden = true;
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
  menuButton.addEventListener("click", () => {
    const willOpen = mobileMenu.hidden;
    mobileMenu.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
  });
  setActiveNavigation(currentRoute());
  refreshNavigationState();
}

async function initialize() {
  try {
    const [contentResponse, catalogResponse, mediaResponse] = await Promise.all([
      fetch(app.dataset.contentUrl, { headers: { Accept: "application/json" } }),
      fetch(app.dataset.catalogUrl, { headers: { Accept: "application/json" } }),
      fetch(app.dataset.mediaUrl, { headers: { Accept: "application/json" } }),
    ]);
    if (!contentResponse.ok) throw new Error(`Week 1 content request failed (${contentResponse.status})`);
    if (!catalogResponse.ok) throw new Error(`Course catalog request failed (${catalogResponse.status})`);
    if (!mediaResponse.ok) throw new Error(`Public media request failed (${mediaResponse.status})`);
    [course, courseCatalog, publicMedia] = await Promise.all([
      contentResponse.json(),
      catalogResponse.json(),
      mediaResponse.json(),
    ]);
    if (publicMedia.$schema !== "cochetopa-public-dendrology-media/1.0" || publicMedia.summary.privateExaminationAssetsIncluded !== 0) {
      throw new Error("Public media manifest failed its examination-isolation check");
    }
    mediaById = new Map(publicMedia.media.map((item) => [item.mediaId, item]));
    prepareStateForCourse();
    pendingCloudState ||= window.cochetopaCloudSnapshot || null;
    if (pendingCloudState) {
      applyCloudState(pendingCloudState, { rerender: false });
      pendingCloudState = null;
    }
    bindNavigation();
    updateProgress();
    renderRoute();
    void refreshFormalTracking({ rerender: true });
  } catch (error) {
    view.innerHTML = `<div class="course-error"><h1>The course could not load</h1><p>${escapeHtml(error.message)}</p></div>`;
  }
}

window.addEventListener("hashchange", () => course && renderRoute());
window.addEventListener("cochetopa-auth-ready", () => {
  if (!course) return;
  if (window.cochetopaCloudSnapshot) {
    applyCloudState(window.cochetopaCloudSnapshot, { rerender: false });
  }
  void refreshFormalTracking({ rerender: true });
  if (currentRoute().startsWith("formal/")) renderRoute();
});
window.addEventListener("cochetopa-cloud-state", (event) => {
  pendingCloudState = event.detail;
  if (!course) return;
  applyCloudState(pendingCloudState);
  pendingCloudState = null;
});

imageDialog.querySelector(".course-dialog-close").addEventListener("click", () => imageDialog.close());
imageDialog.addEventListener("click", (event) => {
  if (event.target === imageDialog) imageDialog.close();
});

initialize();
