// One reference year at 1× takes sixteen real seconds in the Working alpha.
// The default ½× therefore advances every thirty-two seconds, leaving time to
// appreciate stand growth and mortality rather than watching a lifetime rush by.
export const ACTIVE_TIME_BASE_STEP_MS = 16000;

export function createActiveTimeLoop(options) {
  if (typeof options?.getState !== "function") throw new TypeError("Active time requires a state reader.");
  if (typeof options?.advance !== "function") throw new TypeError("Active time requires an advance callback.");

  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  const now = options.now ?? (() => performance.now());
  const baseStepMs = positive(options.baseStepMs ?? ACTIVE_TIME_BASE_STEP_MS, "baseStepMs");
  let timer = null;
  let stopped = true;
  let advancing = false;

  function delayFor(state) {
    const speed = positive(state?.timeSpeed ?? 1, "timeSpeed");
    return baseStepMs / speed;
  }

  function schedule() {
    if (stopped || timer !== null) return;
    const state = options.getState();
    if (state?.paused || state?.setupStage !== "active") return;
    timer = setTimer(run, delayFor(state));
  }

  async function run() {
    timer = null;
    if (stopped) return;
    const state = options.getState();
    if (state?.paused || state?.setupStage !== "active" || advancing) {
      schedule();
      return;
    }
    advancing = true;
    try {
      await options.advance(1, now());
    } finally {
      advancing = false;
      schedule();
    }
  }

  function start() {
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function reschedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    schedule();
  }

  return Object.freeze({ start, stop, reschedule, isRunning: () => !stopped });
}

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${label} must be positive.`);
  return number;
}
