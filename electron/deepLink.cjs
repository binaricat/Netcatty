const fs = require("node:fs");
const path = require("node:path");

const SSH_DEEP_LINK_CHANNEL = "netcatty:deepLink:ssh";
const SSH_PROTOCOL = "ssh";
const SSH_DEEP_LINK_PREFERENCES_FILE = "ssh-deep-link-preferences.json";

function isSshDeepLinkUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  return rawUrl.trim().toLowerCase().startsWith(`${SSH_PROTOCOL}://`);
}

function collectSshDeepLinkUrls(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter(isSshDeepLinkUrl);
}

function registerSshProtocolClient({ app, isDev, argv = process.argv, execPath = process.execPath, logWarn = console.warn } = {}) {
  if (!app || typeof app.setAsDefaultProtocolClient !== "function") return false;
  try {
    if (isDev && process.defaultApp && argv[1]) {
      return app.setAsDefaultProtocolClient(SSH_PROTOCOL, execPath, [argv[1]]);
    }
    return app.setAsDefaultProtocolClient(SSH_PROTOCOL);
  } catch (err) {
    logWarn("[Main] Failed to register ssh:// protocol handler:", err);
    return false;
  }
}

function removeSshProtocolClient({ app, isDev, argv = process.argv, execPath = process.execPath, logWarn = console.warn } = {}) {
  if (!app || typeof app.removeAsDefaultProtocolClient !== "function") return false;
  try {
    if (isDev && process.defaultApp && argv[1]) {
      return app.removeAsDefaultProtocolClient(SSH_PROTOCOL, execPath, [argv[1]]);
    }
    return app.removeAsDefaultProtocolClient(SSH_PROTOCOL);
  } catch (err) {
    logWarn("[Main] Failed to remove ssh:// protocol handler:", err);
    return false;
  }
}

function getSshDeepLinkPreferencePath({ app, pathModule = path } = {}) {
  if (!app || typeof app.getPath !== "function") return null;
  try {
    return pathModule.join(app.getPath("userData"), SSH_DEEP_LINK_PREFERENCES_FILE);
  } catch {
    return null;
  }
}

function readSshDeepLinkEnabledPreference({ app, fsModule = fs, pathModule = path, logWarn = console.warn } = {}) {
  const filePath = getSshDeepLinkPreferencePath({ app, pathModule });
  if (!filePath) return true;
  try {
    if (!fsModule.existsSync(filePath)) return true;
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parsed?.enabled !== false;
  } catch (err) {
    logWarn("[Main] Failed to read ssh:// deep link preference:", err);
    return true;
  }
}

function writeSshDeepLinkEnabledPreference({ app, enabled, fsModule = fs, pathModule = path, logWarn = console.warn } = {}) {
  const filePath = getSshDeepLinkPreferencePath({ app, pathModule });
  if (!filePath) return false;
  try {
    fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
    fsModule.writeFileSync(filePath, JSON.stringify({ enabled: enabled !== false }, null, 2));
    return true;
  } catch (err) {
    logWarn("[Main] Failed to write ssh:// deep link preference:", err);
    return false;
  }
}

function applySshProtocolClientPreference(options = {}) {
  if (options.enabled === false) {
    return removeSshProtocolClient(options);
  }
  return registerSshProtocolClient(options);
}

function updateSshDeepLinkEnabledPreference({
  currentEnabled = true,
  enabled = true,
  applyPreference = () => false,
  writePreference = () => false,
  clearPending,
} = {}) {
  const nextEnabled = enabled !== false;
  if (nextEnabled === currentEnabled) {
    return { enabled: currentEnabled, success: true };
  }

  const success = applyPreference(nextEnabled) === true;
  if (!success) {
    return { enabled: currentEnabled, success: false };
  }

  const writeSucceeded = writePreference(nextEnabled) === true;
  if (!writeSucceeded) {
    const rolledBack = applyPreference(currentEnabled) === true;
    const finalEnabled = rolledBack ? currentEnabled : nextEnabled;
    if (!finalEnabled) {
      clearPending?.();
    }
    return { enabled: finalEnabled, success: false };
  }
  if (!nextEnabled) {
    clearPending?.();
  }
  return { enabled: nextEnabled, success: true };
}

function shouldDeliverSshDeepLink({ enabled = true, deliveryGeneration = 0, expectedGeneration = 0 } = {}) {
  return enabled !== false && deliveryGeneration === expectedGeneration;
}

function applyInitialSshDeepLinkPreference({
  enabled = true,
  applyPreference = () => false,
  clearPending,
  logWarn = console.warn,
} = {}) {
  const requestedEnabled = enabled !== false;
  const success = applyPreference(requestedEnabled) === true;
  if (success) {
    return { enabled: requestedEnabled, success: true };
  }
  logWarn("[Main] Failed to apply saved ssh:// deep link preference.");
  if (requestedEnabled) {
    clearPending?.();
  }
  return { enabled: false, success: false };
}

module.exports = {
  SSH_DEEP_LINK_CHANNEL,
  applyInitialSshDeepLinkPreference,
  collectSshDeepLinkUrls,
  isSshDeepLinkUrl,
  applySshProtocolClientPreference,
  registerSshProtocolClient,
  removeSshProtocolClient,
  readSshDeepLinkEnabledPreference,
  shouldDeliverSshDeepLink,
  updateSshDeepLinkEnabledPreference,
  writeSshDeepLinkEnabledPreference,
};
