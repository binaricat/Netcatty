const {
  canLockFromSettings,
  createAppLockPasswordVerifier,
  normalizeAppLockTimeoutMinutes,
  shouldLockOnBackgroundHide,
  verifyAppLockPassword,
} = require("./appLockSettingsStore.cjs");

function normalizeReason(reason) {
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

function cloneState(state) {
  return {
    initialized: state.initialized === true,
    locked: state.locked === true,
    reason: normalizeReason(state.reason),
    version: state.version,
    lastLockedAt: typeof state.lastLockedAt === "number" ? state.lastLockedAt : null,
    lastUnlockedAt: typeof state.lastUnlockedAt === "number" ? state.lastUnlockedAt : null,
    lastActivityAt: typeof state.lastActivityAt === "number" ? state.lastActivityAt : null,
  };
}

function createAppLockRuntimeBridge() {
  let state = {
    initialized: false,
    locked: false,
    reason: null,
    version: 0,
    lastLockedAt: null,
    lastUnlockedAt: null,
    lastActivityAt: null,
  };

  const listeners = new Set();
  let idleTimerId = null;
  let idleTimerConfig = null;

  function getState() {
    return cloneState(state);
  }

  function notify() {
    const snapshot = getState();
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // ignore subscriber failures
      }
    });
  }

  function clearScheduledTimerOnly() {
    if (idleTimerId !== null) {
      clearTimeout(idleTimerId);
      idleTimerId = null;
    }
  }

  function getTimeoutMs(timeoutMinutes) {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;
    return timeoutMinutes * 60_000;
  }

  function rescheduleIdleTimer() {
    clearScheduledTimerOnly();

    if (!idleTimerConfig || state.initialized !== true || state.locked === true) {
      return;
    }

    const timeoutMs = getTimeoutMs(idleTimerConfig.timeoutMinutes);
    if (timeoutMs === null || typeof state.lastActivityAt !== "number") {
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - state.lastActivityAt);
    const delayMs = Math.max(0, timeoutMs - elapsedMs);

    idleTimerId = setTimeout(() => {
      idleTimerId = null;

      if (!idleTimerConfig || state.initialized !== true || state.locked === true) {
        return;
      }

      const currentTimeoutMs = getTimeoutMs(idleTimerConfig.timeoutMinutes);
      if (currentTimeoutMs === null || typeof state.lastActivityAt !== "number") {
        return;
      }

      const currentElapsedMs = Math.max(0, Date.now() - state.lastActivityAt);
      if (currentElapsedMs < currentTimeoutMs) {
        rescheduleIdleTimer();
        return;
      }

      if (!idleTimerConfig.canLock()) {
        clearIdleTimer();
        return;
      }

      const nextState = lock("idle");
      try {
        idleTimerConfig.onIdleLock(nextState);
      } catch {
        // ignore callback failures
      }
    }, delayMs);
    if (idleTimerId && typeof idleTimerId.unref === "function") {
      idleTimerId.unref();
    }
  }

  function applyStatePatch(patch, { notifyListeners = true } = {}) {
    state = {
      ...state,
      ...patch,
      version: state.version + 1,
    };
    rescheduleIdleTimer();
    if (notifyListeners) {
      notify();
    }
    return getState();
  }

  function initialize(nextState) {
    const now = Date.now();
    const locked = nextState?.locked === true;
    return applyStatePatch({
      initialized: true,
      locked,
      reason: locked ? normalizeReason(nextState?.reason) || "startup" : null,
      lastLockedAt: locked
        ? (typeof nextState?.lastLockedAt === "number" ? nextState.lastLockedAt : now)
        : null,
      lastUnlockedAt: locked
        ? null
        : (typeof nextState?.lastUnlockedAt === "number" ? nextState.lastUnlockedAt : null),
      lastActivityAt: typeof nextState?.lastActivityAt === "number" ? nextState.lastActivityAt : now,
    });
  }

  function lock(reason = "manual") {
    const nextReason = normalizeReason(reason) || "manual";
    if (state.initialized === true && state.locked === true && state.reason === nextReason) {
      return getState();
    }

    return applyStatePatch({
      initialized: true,
      locked: true,
      reason: nextReason,
      lastLockedAt: Date.now(),
    });
  }

  function unlock() {
    const now = Date.now();
    if (state.initialized === true && state.locked === false && state.reason === null) {
      return getState();
    }

    return applyStatePatch({
      initialized: true,
      locked: false,
      reason: null,
      lastUnlockedAt: now,
      lastActivityAt: now,
    });
  }

  function recordActivity(timestamp = Date.now()) {
    if (state.initialized !== true || state.locked === true) {
      return getState();
    }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return getState();
    }
    if (state.lastActivityAt === timestamp) {
      return getState();
    }

    return applyStatePatch(
      {
        lastActivityAt: timestamp,
      },
      { notifyListeners: false },
    );
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function scheduleIdleTimer({ timeoutMinutes, canLock, onIdleLock }) {
    idleTimerConfig = {
      timeoutMinutes,
      canLock: typeof canLock === "function" ? canLock : () => true,
      onIdleLock: typeof onIdleLock === "function" ? onIdleLock : () => {},
    };
    rescheduleIdleTimer();
  }

  function clearIdleTimer() {
    idleTimerConfig = null;
    clearScheduledTimerOnly();
  }

  return {
    initialize,
    getState,
    lock,
    unlock,
    recordActivity,
    subscribe,
    scheduleIdleTimer,
    clearIdleTimer,
  };
}

module.exports = {
  createAppLockController,
  createAppLockRuntimeBridge,
};

function createAppLockController({
  settingsStore,
  runtimeBridge,
  systemAuthBridge = null,
  getMainWindows = () => [],
  // Session windows use registerAsMainWindow:false and are only tracked as
  // app-content windows; they still mount AppLockGate and must receive lock
  // runtime / settings broadcasts (Codex P1).
  getAppContentWindows = () => [],
  getSettingsWindow = () => null,
  getTrayPanelWindow = () => null,
  getTerminalPopupWindows = () => [],
  waitForUnlockFailureDelay = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  if (!settingsStore || typeof settingsStore.getSnapshot !== "function" || typeof settingsStore.save !== "function") {
    throw new Error("createAppLockController requires a settingsStore");
  }
  if (!runtimeBridge || typeof runtimeBridge.getState !== "function") {
    throw new Error("createAppLockController requires a runtimeBridge");
  }

  // Serialize full read-modify-write settings mutations (Codex P2).
  let settingsMutationChain = Promise.resolve();
  // Single in-flight system-auth prompt shared across windows (Codex P2).
  let systemUnlockInFlight = null;
  let passwordUnlockInFlight = null;
  let passwordUnlockFailureCount = 0;
  const lockedWindowTitles = new Map();
  const protectedWindows = new WeakSet();

  function syncIdleTimer() {
    const settings = getSettings();
    if (!canLockFromSettings(settings)) {
      runtimeBridge.clearIdleTimer?.();
      return;
    }

    runtimeBridge.scheduleIdleTimer?.({
      timeoutMinutes: settings.timeoutMinutes,
      canLock: () => canLockFromSettings(getSettings()),
      onIdleLock: (nextState) => {
        broadcast("netcatty:appLock:runtimeStateChanged", nextState);
      },
    });
  }

  function getWindowsForBroadcast() {
    const windows = [
      ...(Array.isArray(getMainWindows()) ? getMainWindows() : []),
      // Detached #/session-window and other app-content-only windows.
      ...(Array.isArray(getAppContentWindows()) ? getAppContentWindows() : []),
      getSettingsWindow(),
      getTrayPanelWindow(),
      ...(Array.isArray(getTerminalPopupWindows()) ? getTerminalPopupWindows() : []),
    ];

    const seen = new Set();
    return windows.filter((win) => {
      if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
      if (!win.webContents || typeof win.webContents.isDestroyed !== "function" || win.webContents.isDestroyed()) {
        return false;
      }

      const id = win.webContents.id || win;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function broadcast(channel, payload) {
    for (const win of getWindowsForBroadcast()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // ignore disposed windows during broadcast
      }
    }
  }

  function enforceWindowProtection(win) {
    if (!win || win.isDestroyed?.() || getRuntimeState()?.locked !== true) return;
    try {
      if (typeof win.getTitle === "function") {
        const currentTitle = win.getTitle();
        if (currentTitle && currentTitle !== "Netcatty") {
          lockedWindowTitles.set(win, currentTitle);
        }
      }
      win.setTitle?.("Netcatty");
      if (win.webContents?.isDevToolsOpened?.()) {
        win.webContents.closeDevTools?.();
      }
    } catch {
      // ignore per-window failures during lock transitions
    }
  }

  // Windows shows the native title-bar menu (Minimize / Maximize / Close) on
  // right-click in -webkit-app-region: drag areas. The lock overlay is a drag
  // region so the window stays movable, so hide that menu while locked.
  function suppressSystemContextMenu(event) {
    if (getRuntimeState()?.locked !== true) return;
    try {
      event?.preventDefault?.();
    } catch {
      // ignore
    }
  }

  function protectWindow(win) {
    if (!win || win.isDestroyed?.()) return;
    if (!protectedWindows.has(win)) {
      protectedWindows.add(win);
      const enforce = () => enforceWindowProtection(win);
      try { win.on?.("show", enforce); } catch { /* ignore */ }
      try { win.on?.("focus", enforce); } catch { /* ignore */ }
      try { win.on?.("system-context-menu", suppressSystemContextMenu); } catch { /* ignore */ }
      try { win.webContents?.on?.("devtools-opened", enforce); } catch { /* ignore */ }
      try {
        win.webContents?.on?.("did-finish-load", () => {
          queueMicrotask(enforce);
        });
      } catch {
        // ignore
      }
    }
    enforceWindowProtection(win);
  }

  function setWindowTitle(win, title) {
    if (!win || win.isDestroyed?.()) return false;
    const nextTitle = typeof title === "string" && title.trim() ? title.trim() : "Netcatty";
    try {
      if (getRuntimeState()?.locked === true) {
        lockedWindowTitles.set(win, nextTitle);
        win.setTitle?.("Netcatty");
        return false;
      }
      win.setTitle?.(nextTitle);
      return true;
    } catch {
      return false;
    }
  }

  function protectWindowsForRuntimeState(nextState) {
    if (nextState?.locked === true) {
      for (const win of getWindowsForBroadcast()) protectWindow(win);
      return;
    }

    for (const [win, title] of lockedWindowTitles) {
      try {
        if (!win.isDestroyed?.() && win.getTitle?.() === "Netcatty") {
          win.setTitle?.(title || "Netcatty");
        }
      } catch {
        // ignore disposed windows during unlock
      }
    }
    lockedWindowTitles.clear();
  }

  // Runtime transitions are the single lock boundary. Idle, background,
  // startup, and manual locks all pass through this subscription.
  runtimeBridge.subscribe?.(protectWindowsForRuntimeState);
  // initialize() can lock the runtime before the controller exists.
  protectWindowsForRuntimeState(runtimeBridge.getState());

  function getSettings() {
    return settingsStore.getSnapshot();
  }

  /**
   * Renderer-facing settings replace real salt/hash with zeroed placeholders of
   * the correct size so presence checks still work, but offline brute-force of
   * the verifier from any renderer is impossible (Codex P2 on 8c0b9c5a).
   * Password verification always runs in main against the private store.
   */
  function getPublicSettings() {
    const settings = getSettings();
    if (!settings || typeof settings !== "object") return settings;
    if (!settings.passwordVerifier) return settings;
    const redactedSalt = Buffer.alloc(16).toString("base64");
    const redactedHash = Buffer.alloc(32).toString("base64");
    return {
      ...settings,
      passwordVerifier: {
        version: settings.passwordVerifier.version,
        algorithm: settings.passwordVerifier.algorithm,
        iterations: settings.passwordVerifier.iterations,
        salt: redactedSalt,
        hash: redactedHash,
      },
    };
  }

  function getRuntimeState() {
    return runtimeBridge.getState();
  }

  async function getSystemAuthStatusOnly() {
    if (!systemAuthBridge || typeof systemAuthBridge.getStatus !== "function") {
      return {
        supported: false,
        available: false,
        platform: "unsupported",
        label: null,
        reason: null,
      };
    }
    try {
      return await systemAuthBridge.getStatus();
    } catch {
      return {
        supported: false,
        available: false,
        platform: "unsupported",
        label: null,
        reason: "failed",
      };
    }
  }

  async function getSystemUnlockStatus() {
    const status = await getSystemAuthStatusOnly();
    const settings = getSettings();
    const canLock = canLockFromSettings(settings);
    return {
      supported: status.supported === true,
      available: status.available === true && canLock,
      enabled: settings.systemUnlockEnabled === true && canLock,
      platform: status.platform || "unsupported",
      label: status.label || null,
      reason: status.reason || null,
    };
  }

  async function saveSettings(nextSettings) {
    const saved = await settingsStore.save(nextSettings);
    syncIdleTimer();
    const publicSaved = getPublicSettings();
    broadcast("netcatty:appLock:settingsChanged", publicSaved);
    return publicSaved;
  }

  /** Queue a full RMW settings mutation so concurrent changes cannot clobber. */
  function mutateSettings(mutator) {
    const run = async () => {
      const current = getSettings();
      const next = await mutator(current);
      if (!next) return getPublicSettings();
      return saveSettings(next);
    };
    const pending = settingsMutationChain.then(run, run);
    settingsMutationChain = pending.then(() => {}, () => {});
    return pending;
  }

  async function requestEnable() {
    return mutateSettings(async (current) => {
      if (!current.passwordVerifier) return null;
      return {
        ...current,
        enabled: true,
      };
    });
  }

  async function requestDisable(currentPassword) {
    // Full RMW on the mutation queue so a concurrent setTimeoutMinutes cannot
    // snapshot pre-disable settings and re-enable App Lock after us (Codex P2).
    let fail = null;
    const saved = await mutateSettings(async (current) => {
      if (current.passwordVerifier) {
        if (!currentPassword) {
          fail = { ok: false, error: "empty-current" };
          return null;
        }
        const verified = await verifyAppLockPassword(currentPassword, current.passwordVerifier);
        if (!verified) {
          fail = { ok: false, error: "incorrect" };
          return null;
        }
      }
      return {
        ...current,
        enabled: false,
        passwordVerifier: null,
        systemUnlockEnabled: false,
        systemUnlockAutoPromptEnabled: false,
      };
    });
    if (fail) return fail;
    const runtimeState = runtimeBridge.unlock();
    syncIdleTimer();
    broadcast("netcatty:appLock:runtimeStateChanged", runtimeState);
    return saved;
  }

  async function requestReset(currentPassword) {
    let fail = null;
    const saved = await mutateSettings(async (current) => {
      const verified = await verifyCurrentPassword(current, currentPassword);
      if (verified !== true) {
        fail = verified;
        return null;
      }
      return {
        ...current,
        enabled: false,
        passwordVerifier: null,
        systemUnlockEnabled: false,
        systemUnlockAutoPromptEnabled: false,
      };
    });
    if (fail) return fail;
    const runtimeState = runtimeBridge.unlock();
    syncIdleTimer();
    broadcast("netcatty:appLock:runtimeStateChanged", runtimeState);
    return saved;
  }

  async function requestPasswordChange(input = {}) {
    const nextPassword = typeof input.nextPassword === "string" ? input.nextPassword : "";
    const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
    const hadVerifierAtRequest = Boolean(getSettings().passwordVerifier);

    if (nextPassword.trim() === "") {
      return { ok: false, error: "empty-next" };
    }
    let fail = null;
    let enablingFromNoVerifier = false;
    const saved = await mutateSettings(async (current) => {
      // A password-change request must not turn into a first-time enable if a
      // disable/reset queued ahead of it removed the verifier.
      if (hadVerifierAtRequest && !current.passwordVerifier) {
        fail = { ok: false, error: "incorrect" };
        return null;
      }
      if (current.passwordVerifier) {
        if (!currentPassword) {
          fail = { ok: false, error: "empty-current" };
          return null;
        }
        const verified = await verifyAppLockPassword(currentPassword, current.passwordVerifier);
        if (!verified) {
          fail = { ok: false, error: "incorrect" };
          return null;
        }
      }

      enablingFromNoVerifier = !current.passwordVerifier;
      const passwordVerifier = await createAppLockPasswordVerifier(nextPassword);
      return {
        ...current,
        enabled: current.enabled || enablingFromNoVerifier,
        passwordVerifier,
      };
    });
    if (fail) return fail;
    // While lock was disabled the renderer never reported activity. Re-arming
    // the idle timer on enable would schedule an immediate lock if Netcatty
    // has been open longer than the timeout. Record fresh activity first
    // (Codex P2 on dbe1a746).
    if (enablingFromNoVerifier) {
      try { runtimeBridge.recordActivity(Date.now()); } catch { /* ignore */ }
      syncIdleTimer();
    }
    return saved;
  }

  async function setTimeoutMinutes(timeoutMinutes) {
    return mutateSettings(async (current) => ({
      ...current,
      timeoutMinutes: normalizeAppLockTimeoutMinutes(timeoutMinutes),
    }));
  }

  async function verifyCurrentPassword(current, currentPassword) {
    if (!current.passwordVerifier) return true;
    if (!currentPassword) return { ok: false, error: "empty-current" };
    const verified = await verifyAppLockPassword(currentPassword, current.passwordVerifier);
    if (!verified) return { ok: false, error: "incorrect" };
    return true;
  }

  async function setSystemUnlockEnabled(input = {}) {
    const enabled = input?.enabled === true;
    const autoPromptEnabled = input?.autoPromptEnabled === true;
    const currentPassword = typeof input?.currentPassword === "string" ? input.currentPassword : "";
    const current = getSettings();
    if (!canLockFromSettings(current)) {
      return { ok: false, error: "unavailable" };
    }

    if (!enabled) {
      if (runtimeBridge.getState().locked === true && !currentPassword) {
        return { ok: false, error: "locked" };
      }
      if (currentPassword) {
        const verified = await verifyCurrentPassword(current, currentPassword);
        if (verified !== true) return verified;
      }
      return mutateSettings(async (latest) => ({
        ...latest,
        systemUnlockEnabled: false,
        systemUnlockAutoPromptEnabled: false,
      }));
    }

    if (current.systemUnlockEnabled === true) {
      return mutateSettings(async (latest) => ({
        ...latest,
        systemUnlockAutoPromptEnabled: autoPromptEnabled,
      }));
    }

    const status = await getSystemAuthStatusOnly();
    if (status.supported !== true) return { ok: false, error: "unsupported" };
    if (status.available !== true) return { ok: false, error: "unavailable" };
    if (!systemAuthBridge || typeof systemAuthBridge.requestUnlock !== "function") {
      return { ok: false, error: "unsupported" };
    }

    const result = await systemAuthBridge.requestUnlock();
    if (!result || result.ok !== true) {
      return {
        ok: false,
        error: result?.error || "failed",
      };
    }

    return mutateSettings(async (latest) => ({
      ...latest,
      systemUnlockEnabled: true,
      systemUnlockAutoPromptEnabled: autoPromptEnabled,
    }));
  }

  function setLocked(reason) {
    const settings = getSettings();
    if (!canLockFromSettings(settings)) {
      return getRuntimeState();
    }
    // Close-to-tray and app-hide use reason "background". Honor "Never
    // lock automatically" so hiding the window does not prompt for a password.
    if (reason === "background" && !shouldLockOnBackgroundHide(settings)) {
      return getRuntimeState();
    }
    const nextState = runtimeBridge.lock(reason);
    syncIdleTimer();
    broadcast("netcatty:appLock:runtimeStateChanged", nextState);
    return nextState;
  }

  function isSamePasswordVerifier(a, b) {
    return Boolean(
      a
      && b
      && a.version === b.version
      && a.algorithm === b.algorithm
      && a.iterations === b.iterations
      && a.salt === b.salt
      && a.hash === b.hash
    );
  }

  async function rejectPasswordUnlockAttempt() {
    passwordUnlockFailureCount += 1;
    const delayMs = 250 * (2 ** Math.min(passwordUnlockFailureCount - 1, 3));
    await waitForUnlockFailureDelay(delayMs);
    return { ok: false, error: "incorrect" };
  }

  async function requestUnlockAttempt(password, requestContext) {
    const current = getSettings();
    if (!canLockFromSettings(current)) {
      passwordUnlockFailureCount = 0;
      const nextState = runtimeBridge.unlock();
      syncIdleTimer();
      broadcast("netcatty:appLock:runtimeStateChanged", nextState);
      return { ok: true };
    }
    if (!password) {
      return { ok: false, error: "empty" };
    }

    const lockAtAttempt = requestContext.lockState;
    if (
      lockAtAttempt.locked !== true
      || !isSamePasswordVerifier(requestContext.passwordVerifier, current.passwordVerifier)
    ) {
      return rejectPasswordUnlockAttempt();
    }
    const verified = await verifyAppLockPassword(password, requestContext.passwordVerifier);
    const latest = getSettings();
    const lockAfterVerify = runtimeBridge.getState();
    const staleAttempt = !isSamePasswordVerifier(requestContext.passwordVerifier, latest.passwordVerifier)
      || lockAfterVerify.locked !== true
      || lockAfterVerify.version !== lockAtAttempt.version;
    if (!verified || staleAttempt) {
      return rejectPasswordUnlockAttempt();
    }

    passwordUnlockFailureCount = 0;
    const nextState = runtimeBridge.unlock();
    syncIdleTimer();
    broadcast("netcatty:appLock:runtimeStateChanged", nextState);
    return { ok: true };
  }

  function requestUnlock(password) {
    const current = getSettings();
    const requestContext = {
      lockState: runtimeBridge.getState(),
      passwordVerifier: current.passwordVerifier,
    };
    if (!canLockFromSettings(current)) {
      return requestUnlockAttempt(password, requestContext);
    }
    // Calls made while unlocked must never enter a queue that can delay a
    // later legitimate unlock after idle/background locking.
    if (requestContext.lockState.locked !== true) {
      return Promise.resolve({ ok: false, error: "incorrect" });
    }
    // At most one expensive password attempt may be active. Concurrent IPC
    // calls share it instead of creating an unbounded PBKDF/backoff queue.
    if (passwordUnlockInFlight) return passwordUnlockInFlight;
    passwordUnlockInFlight = requestUnlockAttempt(password, requestContext);
    return passwordUnlockInFlight.finally(() => {
      passwordUnlockInFlight = null;
    });
  }

  async function requestSystemUnlock() {
    if (systemUnlockInFlight) {
      return systemUnlockInFlight;
    }
    systemUnlockInFlight = (async () => {
      const current = getSettings();
      if (!canLockFromSettings(current)) return { ok: false, error: "unavailable" };
      if (current.systemUnlockEnabled !== true) return { ok: false, error: "disabled" };
      // Capture the lock presentation epoch before the OS prompt. A re-lock
      // (idle → background) advances version while staying locked; accepting a
      // stale prompt would unlock the newer lock (Codex P2).
      const lockAtPrompt = runtimeBridge.getState();
      if (lockAtPrompt.locked !== true) return { ok: false, error: "not-locked" };
      const lockVersionAtPrompt = lockAtPrompt.version;

      const status = await getSystemAuthStatusOnly();
      if (status.supported !== true) return { ok: false, error: "unsupported" };
      if (status.available !== true) return { ok: false, error: "unavailable" };
      if (!systemAuthBridge || typeof systemAuthBridge.requestUnlock !== "function") {
        return { ok: false, error: "unsupported" };
      }

      const result = await systemAuthBridge.requestUnlock();
      if (!result || result.ok !== true) {
        return {
          ok: false,
          error: result?.error || "failed",
        };
      }
      const latestSettings = getSettings();
      if (
        !canLockFromSettings(latestSettings)
        || latestSettings.systemUnlockEnabled !== true
      ) {
        return { ok: false, error: "disabled" };
      }
      // Drop the prompt result if we unlocked, re-locked, or the lock reason
      // changed while the dialog was open (version advances on each lock patch).
      const lockAfterPrompt = runtimeBridge.getState();
      if (
        lockAfterPrompt.locked !== true
        || lockAfterPrompt.version !== lockVersionAtPrompt
      ) {
        return { ok: false, error: "not-locked" };
      }

      const nextState = runtimeBridge.unlock();
      syncIdleTimer();
      broadcast("netcatty:appLock:runtimeStateChanged", nextState);
      return { ok: true };
    })();
    try {
      return await systemUnlockInFlight;
    } finally {
      systemUnlockInFlight = null;
    }
  }

  function reportActivity(timestamp = Date.now()) {
    const nextState = runtimeBridge.recordActivity(timestamp);
    syncIdleTimer();
    return nextState;
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("netcatty:appLock:getRuntimeState", () => getRuntimeState());
    ipcMain.handle("netcatty:appLock:getSettings", () => getPublicSettings());
    ipcMain.handle("netcatty:appLock:setTimeoutMinutes", (_event, timeoutMinutes) =>
      setTimeoutMinutes(timeoutMinutes));
    ipcMain.handle("netcatty:appLock:requestEnable", () => requestEnable());
    ipcMain.handle("netcatty:appLock:requestDisable", (_event, currentPassword) =>
      requestDisable(currentPassword));
    ipcMain.handle("netcatty:appLock:requestReset", (_event, currentPassword) =>
      requestReset(currentPassword));
    ipcMain.handle("netcatty:appLock:requestPasswordChange", (_event, input) =>
      requestPasswordChange(input));
    ipcMain.handle("netcatty:appLock:setLocked", (_event, reason) => setLocked(reason));
    ipcMain.handle("netcatty:appLock:requestUnlock", (_event, password) =>
      requestUnlock(password));
    ipcMain.handle("netcatty:appLock:getSystemUnlockStatus", () =>
      getSystemUnlockStatus());
    ipcMain.handle("netcatty:appLock:setSystemUnlockEnabled", (_event, input) =>
      setSystemUnlockEnabled(input));
    ipcMain.handle("netcatty:appLock:requestSystemUnlock", () =>
      requestSystemUnlock());
    ipcMain.handle("netcatty:appLock:reportActivity", () => reportActivity());
  }

  return {
    getSettings,
    getRuntimeState,
    /** Subscribe to runtime lock/unlock transitions (used by tray deferral). */
    subscribe: (listener) => runtimeBridge.subscribe(listener),
    requestEnable,
    requestDisable,
    requestReset,
    requestPasswordChange,
    setTimeoutMinutes,
    setLocked,
    requestUnlock,
    getSystemUnlockStatus,
    setSystemUnlockEnabled,
    requestSystemUnlock,
    reportActivity,
    protectWindow,
    setWindowTitle,
    registerHandlers,
    syncIdleTimer,
  };
}
