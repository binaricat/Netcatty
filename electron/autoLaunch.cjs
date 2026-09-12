/**
 * Auto Launch - Registers Netcatty to start at system login, hidden to the
 * tray. Thin wrapper around Electron's app.setLoginItemSettings/
 * getLoginItemSettings so main.cjs and the settings IPC handlers share one
 * source of truth.
 *
 * Development runs (`electron .`) are unsupported: process.execPath points
 * at the transient electron.exe, so a login item registered there would
 * break (or silently do nothing) after the dev process exits.
 *
 * Platform support is further limited to macOS and Windows: Electron's
 * login-item API is a no-op on Linux, which ships as AppImage/deb/rpm/pacman
 * with no first-party autostart hook, so reporting it as supported there
 * would show an enabled toggle that does nothing.
 */

const HIDDEN_LAUNCH_ARG = "--hidden";

function isAutoLaunchSupported({ defaultApp = process.defaultApp, platform = process.platform } = {}) {
  if (defaultApp) return false;
  return platform === "darwin" || platform === "win32";
}

function argsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Find the specific Windows run-key entry our own writes create (path +
 * --hidden args), not just any entry for this executable.
 */
function findMatchingLaunchItem(settings, execPath) {
  if (!Array.isArray(settings?.launchItems)) return null;
  return settings.launchItems.find(
    (item) => item?.path === execPath && argsEqual(item?.args, [HIDDEN_LAUNCH_ARG]),
  ) ?? null;
}

/**
 * Resolve the OS's effective auto-launch state, not just whether a
 * registration exists.
 *
 * Windows can retain the run-key entry while the user disables it via Task
 * Manager's Startup Apps UI. Electron's executableWillLaunchAtLogin surfaces
 * an effective state too, but it deliberately ignores the args option and
 * reports true if the executable would launch with ANY arguments — so it
 * can false-positive on an unrelated no-argument entry for the same exe.
 * launchItems[].enabled is scoped to one specific path+args registration
 * (the same combination buildLoginItemQueryOptions queries), so look up our
 * own --hidden entry there instead and use its enabled flag.
 */
function resolveEffectiveLoginState(settings, platform, execPath) {
  if (platform === "win32") {
    const matchingItem = findMatchingLaunchItem(settings, execPath);
    if (matchingItem) return Boolean(matchingItem.enabled);
    // No matching --hidden entry: openAtLogin was queried with the same
    // path+args (see buildLoginItemQueryOptions), so it is still correctly
    // scoped to "is that exact entry registered" — false if absent.
    return Boolean(settings?.openAtLogin);
  }
  if (platform === "darwin" && settings?.status === "requires-approval") {
    // macOS 13+ (SMAppService): a freshly registered login item sits in
    // "requires-approval" until the user approves it in System Settings,
    // during which openAtLogin reports false even though registration
    // itself succeeded. Reporting false here would make the renderer's
    // push effect see a mismatch against what the user just requested and
    // immediately fire an opposite write, unregistering the pending item
    // before the user ever gets a chance to approve it. Treat pending
    // approval as enabled; a later read naturally reflects the real state
    // once the user approves it (or the OS drops the pending request).
    return true;
  }
  return Boolean(settings?.openAtLogin);
}

/**
 * Electron's getLoginItemSettings() only reports openAtLogin for the
 * specific path+args combination you ask about — it does not mean "is
 * anything registered for this app". Our code only ever registers a login
 * item with args:[HIDDEN_LAUNCH_ARG], so every read must query that exact
 * combination (matching what setAutoLaunchEnabled writes) or Windows
 * reports a false negative.
 */
function buildLoginItemQueryOptions(execPath) {
  return { path: execPath, args: [HIDDEN_LAUNCH_ARG] };
}

function getAutoLaunchEnabled({
  app,
  execPath = process.execPath,
  defaultApp = process.defaultApp,
  platform = process.platform,
} = {}) {
  if (!isAutoLaunchSupported({ defaultApp, platform })) {
    return { success: true, enabled: false, supported: false };
  }
  try {
    const settings = app.getLoginItemSettings(buildLoginItemQueryOptions(execPath));
    return { success: true, enabled: resolveEffectiveLoginState(settings, platform, execPath), supported: true };
  } catch (err) {
    console.warn("[AutoLaunch] Failed to read login item settings:", err?.message || err);
    // success:false signals "OS state unknown" (as opposed to a confirmed
    // disabled state) so callers — notably the renderer's mount-time
    // hydration — know not to trust `enabled` here. Blindly applying
    // enabled:false on a transient read failure would overwrite the
    // renderer's cached value and cascade into an unwanted disable write.
    return { success: false, enabled: false, supported: true };
  }
}

function setAutoLaunchEnabled(enabled, {
  app,
  execPath = process.execPath,
  defaultApp = process.defaultApp,
  platform = process.platform,
} = {}) {
  if (!isAutoLaunchSupported({ defaultApp, platform })) {
    // enabled:false is a confirmed fact here (the feature genuinely isn't
    // available), not an unknown state — matches getAutoLaunchEnabled's
    // equivalent branch so both functions agree on what `success` means.
    return { success: true, enabled: false, supported: false };
  }
  const wantEnabled = Boolean(enabled);
  try {
    app.setLoginItemSettings({
      openAtLogin: wantEnabled,
      // openAsHidden only applies on macOS App Store builds; Windows relies
      // on the --hidden arg below, which main.cjs checks on cold start.
      openAsHidden: wantEnabled,
      path: execPath,
      args: wantEnabled ? [HIDDEN_LAUNCH_ARG] : [],
    });
    const settings = app.getLoginItemSettings(buildLoginItemQueryOptions(execPath));
    return { success: true, enabled: resolveEffectiveLoginState(settings, platform, execPath), supported: true };
  } catch (err) {
    console.warn("[AutoLaunch] Failed to update login item settings:", err?.message || err);
    // `success` means "is `enabled` trustworthy", not "did the write
    // succeed" — the write itself failing does not make a subsequent,
    // independent read failing too. Surface whatever the fallback read
    // determines: if it succeeds, `enabled` reflects the real (unwritten)
    // state and the renderer's push effect correctly rolls the optimistic
    // toggle back instead of leaving it stuck on a change that never
    // actually happened. Only a genuine double failure (write AND fallback
    // read both throw) reports success:false, so the renderer preserves its
    // last-known state instead of guessing.
    const fallback = getAutoLaunchEnabled({ app, execPath, defaultApp, platform });
    return { success: fallback.success, enabled: fallback.enabled, supported: true };
  }
}

/**
 * True when this process was launched by the OS login item (cold start
 * only). Windows relies on the --hidden arg (macOS never puts args from
 * setLoginItemSettings() into argv for a login launch, so it needs a
 * different signal).
 *
 * macOS's own hidden-launch flags (openAsHidden/wasOpenedAsHidden) are
 * deprecated and stop working on macOS 13+ per Electron's docs, so they
 * cannot be trusted to detect an actual hidden launch there. wasOpenedAtLogin
 * still works on 13+ and is not deprecated; since Netcatty only ever
 * registers a macOS login item to satisfy this "launch hidden" feature (there
 * is no scenario where it registers one for a normal, visible startup), any
 * automatic login launch should apply our own hidden-window behavior.
 */
function wasLaunchedHidden({ argv = process.argv, app, platform = process.platform } = {}) {
  if (Array.isArray(argv) && argv.includes(HIDDEN_LAUNCH_ARG)) return true;
  if (platform !== "darwin" || typeof app?.getLoginItemSettings !== "function") return false;
  try {
    return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch (err) {
    console.warn("[AutoLaunch] Failed to read macOS login-item launch state:", err?.message || err);
    return false;
  }
}

function registerHandlers(ipcMain, { app, platform = process.platform }) {
  ipcMain.handle("netcatty:autoLaunch:get", async () => {
    return getAutoLaunchEnabled({ app, platform });
  });

  ipcMain.handle("netcatty:autoLaunch:set", async (_event, { enabled }) => {
    return setAutoLaunchEnabled(enabled, { app, platform });
  });
}

module.exports = {
  HIDDEN_LAUNCH_ARG,
  isAutoLaunchSupported,
  resolveEffectiveLoginState,
  buildLoginItemQueryOptions,
  getAutoLaunchEnabled,
  setAutoLaunchEnabled,
  wasLaunchedHidden,
  registerHandlers,
};
