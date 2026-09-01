const root = document.querySelector("#course-account");
const status = document.querySelector("#course-account-status");
const form = document.querySelector("#course-signin-form");
const emailInput = document.querySelector("#course-signin-email");
const signOutButton = document.querySelector("#course-signout");
const captchaHost = document.querySelector("#course-turnstile");
const reminderForm = document.querySelector("#course-reminder-form");
const reminderOptIn = document.querySelector("#course-reminder-opt-in");
const reminderCadence = document.querySelector("#course-reminder-cadence");

let client = null;
let config = null;
let session = null;
let captchaToken = null;
let captchaWidgetId = null;
let pendingSnapshot = null;
let syncTimer = null;

function setStatus(message, kind = "neutral") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function renderAccount() {
  const signedIn = Boolean(session?.user);
  form.hidden = signedIn;
  signOutButton.hidden = !signedIn;
  reminderForm.hidden = !signedIn;
  root.dataset.signedIn = String(signedIn);
  if (signedIn) {
    setStatus(`Signed in as ${session.user.email}. Progress is syncing.`, "success");
  }
}

async function loadReminderPreference() {
  if (!client || !session?.user) return;
  const { data, error } = await client
    .from("reminder_preferences")
    .select("opted_in,cadence")
    .eq("course_id", config.courseId)
    .maybeSingle();
  if (error) throw error;
  reminderOptIn.checked = Boolean(data?.opted_in);
  reminderCadence.value = data?.cadence || "weekly";
}

async function saveReminderPreference(event) {
  event.preventDefault();
  if (!session?.user) return;
  const optedIn = reminderOptIn.checked && reminderCadence.value !== "off";
  const { error } = await client.from("reminder_preferences").upsert({
    user_id: session.user.id,
    course_id: config.courseId,
    opted_in: optedIn,
    cadence: optedIn ? reminderCadence.value : "off",
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,course_id" });
  if (error) {
    setStatus("The reminder preference could not be saved. No new email consent was recorded.", "warning");
    return;
  }
  setStatus(optedIn ? "Reminder preference saved. You can turn it off here at any time." : "Course reminders are off.", "success");
}

function dispatchCloudState(snapshot) {
  window.dispatchEvent(new CustomEvent("cochetopa-cloud-state", { detail: snapshot }));
}

async function loadSnapshot() {
  if (!client || !session?.user) return null;
  const { data, error } = await client
    .from("course_state_snapshots")
    .select("state, updated_at")
    .eq("course_id", config.courseId)
    .maybeSingle();
  if (error) throw error;
  if (data?.state) dispatchCloudState(data.state);
  return data?.state || null;
}

async function flushSnapshot() {
  if (!pendingSnapshot || !client || !session?.user) return;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  const { error } = await client.from("course_state_snapshots").upsert({
    user_id: session.user.id,
    course_id: config.courseId,
    course_version: config.courseVersion,
    state: snapshot,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,course_id" });
  if (error) {
    pendingSnapshot = snapshot;
    setStatus("Signed in, but the latest progress sync failed. It remains saved on this device.", "warning");
    return;
  }
  setStatus(`Signed in as ${session.user.email}. Progress is synced.`, "success");
}

function queueSnapshot(snapshot) {
  pendingSnapshot = snapshot;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(flushSnapshot, 900);
}

function resetCaptcha() {
  captchaToken = null;
  if (window.turnstile && captchaWidgetId != null) window.turnstile.reset(captchaWidgetId);
}

async function renderTurnstile() {
  if (!config.turnstileSiteKey) return;
  await new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  captchaWidgetId = window.turnstile.render(captchaHost, {
    sitekey: config.turnstileSiteKey,
    theme: "light",
    callback: (token) => { captchaToken = token; },
    "expired-callback": () => { captchaToken = null; },
    "error-callback": () => { captchaToken = null; },
  });
}

async function requestMagicLink(event) {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!email || !form.reportValidity()) return;
  if (config.turnstileSiteKey && !captchaToken) {
    setStatus("Complete the human-verification check first.", "warning");
    return;
  }
  form.querySelector("button").disabled = true;
  setStatus("Requesting a secure sign-in link…");
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      captchaToken: captchaToken || undefined,
    },
  });
  form.querySelector("button").disabled = false;
  resetCaptcha();
  // Keep the response generic so the UI does not reveal account existence.
  if (error) {
    setStatus("If the address can receive course mail, a sign-in message will arrive shortly. Please wait before retrying.", "neutral");
    return;
  }
  setStatus("Check your email for the one-time Cochetopa sign-in link. You may close this tab and return from the link.", "success");
}

async function initialize() {
  try {
    const response = await fetch(root.dataset.configUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`runtime configuration request failed (${response.status})`);
    config = await response.json();
    if (!config.cloudFeaturesEnabled) {
      form.hidden = true;
      signOutButton.hidden = true;
      setStatus("Cloud sign-in is staged but not connected. Course progress is currently stored on this device.");
      window.cochetopaAuth = { enabled: false, signedIn: () => false };
      window.dispatchEvent(new CustomEvent("cochetopa-auth-ready"));
      return;
    }
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error("cloud configuration is incomplete");
    const { createClient } = await import(config.supabaseJsModuleUrl);
    client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    await renderTurnstile();
    const { data } = await client.auth.getSession();
    session = data.session;
    renderAccount();
    if (session) await Promise.all([loadSnapshot(), loadReminderPreference()]);
    client.auth.onAuthStateChange(async (_event, nextSession) => {
      session = nextSession;
      renderAccount();
      if (session) await Promise.all([loadSnapshot(), loadReminderPreference()]);
    });
    async function formalRequest(body) {
      const current = (await client.auth.getSession()).data.session;
      if (!current) throw new Error("Sign in before opening a formal assessment.");
      const response = await fetch(`${config.supabaseUrl}/functions/v1/formal-assessment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${current.access_token}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("The secure assessment service did not accept this request.");
      return response.json();
    }
    window.cochetopaAuth = {
      enabled: true,
      signedIn: () => Boolean(session?.user),
      queueSnapshot,
      flushSnapshot,
      loadSnapshot,
      createOrResumeFormal: (assessmentId) => formalRequest({ action: "create_or_resume", assessmentId }),
      submitFormalItem: (formId, part, itemNumber, response) => formalRequest({ action: "submit_station", formId, part, itemNumber, response }),
      submitFormalStation: (formId, stationNumber, response) => formalRequest({ action: "submit_station", formId, part: "visual", itemNumber: stationNumber, response }),
      getGradeSummary: () => formalRequest({ action: "grade_summary" }),
      getReviewQueue: () => formalRequest({ action: "review_queue" }),
      reviewFormalItem: (formId, part, itemNumber, awardedPoints, reviewNotes) => formalRequest({
        action: "review_item", formId, part, itemNumber, awardedPoints, reviewNotes,
      }),
      formalMediaUrl: (token) => `${config.supabaseUrl}/functions/v1/formal-media?token=${encodeURIComponent(token)}`,
    };
    window.dispatchEvent(new CustomEvent("cochetopa-auth-ready"));
  } catch (error) {
    form.hidden = true;
    setStatus(`Cloud sign-in is unavailable; local course progress still works. (${error.message})`, "warning");
  }
}

form.addEventListener("submit", requestMagicLink);
reminderForm.addEventListener("submit", saveReminderPreference);
signOutButton.addEventListener("click", async () => {
  await flushSnapshot();
  await client?.auth.signOut();
  session = null;
  renderAccount();
  setStatus("Signed out. Local progress remains on this device.");
});
window.addEventListener("cochetopa-local-state", (event) => queueSnapshot(event.detail));
window.addEventListener("pagehide", () => { void flushSnapshot(); });

initialize();
