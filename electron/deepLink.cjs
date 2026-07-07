const fs = require("node:fs");
const path = require("node:path");

const SSH_DEEP_LINK_CHANNEL = "netcatty:deepLink:ssh";
const TELNET_DEEP_LINK_CHANNEL = "netcatty:deepLink:telnet";
const JMS_DEEP_LINK_CHANNEL = "netcatty:deepLink:jms";
const SSH_PROTOCOL = "ssh";
const TELNET_PROTOCOL = "telnet";
const JMS_PROTOCOL = "jms";
const SSH_DEEP_LINK_PREFERENCES_FILE = "ssh-deep-link-preferences.json";
const JMS_DEEP_LINK_PREFERENCES_FILE = "jms-deep-link-preferences.json";

function isDeepLinkUrl(rawUrl, protocol) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  return rawUrl.trim().toLowerCase().startsWith(`${protocol}://`);
}

function collectDeepLinkUrls(argv, protocol) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((rawUrl) => isDeepLinkUrl(rawUrl, protocol));
}

function isSshDeepLinkUrl(rawUrl) {
  return isDeepLinkUrl(rawUrl, SSH_PROTOCOL);
}

function isTelnetDeepLinkUrl(rawUrl) {
  return isDeepLinkUrl(rawUrl, TELNET_PROTOCOL);
}

function isJmsDeepLinkUrl(rawUrl) {
  return isDeepLinkUrl(rawUrl, JMS_PROTOCOL);
}

function collectSshDeepLinkUrls(argv) {
  return collectDeepLinkUrls(argv, SSH_PROTOCOL);
}

function collectTelnetDeepLinkUrls(argv) {
  return collectDeepLinkUrls(argv, TELNET_PROTOCOL);
}

function collectJmsDeepLinkUrls(argv) {
  return collectDeepLinkUrls(argv, JMS_PROTOCOL);
}

function registerProtocolClient({
  app,
  protocol,
  isDev,
  argv = process.argv,
  execPath = process.execPath,
  logWarn = console.warn,
} = {}) {
  if (!app || typeof app.setAsDefaultProtocolClient !== "function") return false;
  try {
    if (isDev && process.defaultApp && argv[1]) {
      return app.setAsDefaultProtocolClient(protocol, execPath, [argv[1]]);
    }
    return app.setAsDefaultProtocolClient(protocol);
  } catch (err) {
    logWarn(`[Main] Failed to register ${protocol}:// protocol handler:`, err);
    return false;
  }
}

function removeProtocolClient({
  app,
  protocol,
  isDev,
  argv = process.argv,
  execPath = process.execPath,
  logWarn = console.warn,
} = {}) {
  if (!app || typeof app.removeAsDefaultProtocolClient !== "function") return false;
  try {
    if (isDev && process.defaultApp && argv[1]) {
      return app.removeAsDefaultProtocolClient(protocol, execPath, [argv[1]]);
    }
    return app.removeAsDefaultProtocolClient(protocol);
  } catch (err) {
    logWarn(`[Main] Failed to remove ${protocol}:// protocol handler:`, err);
    return false;
  }
}

function registerSshProtocolClient(options = {}) {
  return registerProtocolClient({ ...options, protocol: SSH_PROTOCOL });
}

function registerTelnetProtocolClient(options = {}) {
  return registerProtocolClient({ ...options, protocol: TELNET_PROTOCOL });
}

function removeSshProtocolClient(options = {}) {
  return removeProtocolClient({ ...options, protocol: SSH_PROTOCOL });
}

function removeTelnetProtocolClient(options = {}) {
  return removeProtocolClient({ ...options, protocol: TELNET_PROTOCOL });
}

function registerJmsProtocolClient(options = {}) {
  return registerProtocolClient({ ...options, protocol: JMS_PROTOCOL });
}

function removeJmsProtocolClient(options = {}) {
  return removeProtocolClient({ ...options, protocol: JMS_PROTOCOL });
}

function getDeepLinkPreferencePath({ app, preferencesFile, pathModule = path } = {}) {
  if (!app || typeof app.getPath !== "function") return null;
  try {
    return pathModule.join(app.getPath("userData"), preferencesFile);
  } catch {
    return null;
  }
}

function getSshDeepLinkPreferencePath(options = {}) {
  return getDeepLinkPreferencePath({
    ...options,
    preferencesFile: SSH_DEEP_LINK_PREFERENCES_FILE,
  });
}

function getJmsDeepLinkPreferencePath(options = {}) {
  return getDeepLinkPreferencePath({
    ...options,
    preferencesFile: JMS_DEEP_LINK_PREFERENCES_FILE,
  });
}

function readDeepLinkEnabledPreference({
  app,
  preferencesFile,
  defaultWhenMissing,
  parseEnabled,
  fsModule = fs,
  pathModule = path,
  logWarn = console.warn,
  logLabel,
} = {}) {
  const filePath = getDeepLinkPreferencePath({ app, preferencesFile, pathModule });
  if (!filePath) return defaultWhenMissing;
  try {
    if (!fsModule.existsSync(filePath)) return defaultWhenMissing;
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parseEnabled(parsed);
  } catch (err) {
    logWarn(`[Main] Failed to read ${logLabel} deep link preference:`, err);
    return defaultWhenMissing;
  }
}

function readSshDeepLinkEnabledPreference(options = {}) {
  return readDeepLinkEnabledPreference({
    ...options,
    preferencesFile: SSH_DEEP_LINK_PREFERENCES_FILE,
    defaultWhenMissing: true,
    parseEnabled: (parsed) => parsed?.enabled !== false,
    logLabel: "ssh://",
  });
}

function readJmsDeepLinkEnabledPreference(options = {}) {
  return readDeepLinkEnabledPreference({
    ...options,
    preferencesFile: JMS_DEEP_LINK_PREFERENCES_FILE,
    defaultWhenMissing: false,
    parseEnabled: (parsed) => parsed?.enabled === true,
    logLabel: "jms://",
  });
}

function writeDeepLinkEnabledPreference({
  app,
  enabled,
  preferencesFile,
  fsModule = fs,
  pathModule = path,
  logWarn = console.warn,
  logLabel,
} = {}) {
  const filePath = getDeepLinkPreferencePath({ app, preferencesFile, pathModule });
  if (!filePath) return false;
  try {
    fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
    fsModule.writeFileSync(filePath, JSON.stringify({ enabled: enabled !== false }, null, 2));
    return true;
  } catch (err) {
    logWarn(`[Main] Failed to write ${logLabel} deep link preference:`, err);
    return false;
  }
}

function writeSshDeepLinkEnabledPreference(options = {}) {
  return writeDeepLinkEnabledPreference({
    ...options,
    preferencesFile: SSH_DEEP_LINK_PREFERENCES_FILE,
    logLabel: "ssh://",
  });
}

function writeJmsDeepLinkEnabledPreference(options = {}) {
  return writeDeepLinkEnabledPreference({
    ...options,
    preferencesFile: JMS_DEEP_LINK_PREFERENCES_FILE,
    logLabel: "jms://",
  });
}

function applyDeepLinkProtocolClientPreference({
  enabled,
  registerClient,
  removeClient,
  options = {},
} = {}) {
  if (enabled === false) {
    return removeClient(options);
  }
  return registerClient(options);
}

function applySshProtocolClientPreference(options = {}) {
  const sshApplied = applyDeepLinkProtocolClientPreference({
    enabled: options.enabled,
    registerClient: registerSshProtocolClient,
    removeClient: removeSshProtocolClient,
    options,
  });
  const telnetApplied = applyDeepLinkProtocolClientPreference({
    enabled: options.enabled,
    registerClient: registerTelnetProtocolClient,
    removeClient: removeTelnetProtocolClient,
    options,
  });
  if (sshApplied !== true && telnetApplied === true) {
    applyDeepLinkProtocolClientPreference({
      enabled: options.enabled === false,
      registerClient: registerTelnetProtocolClient,
      removeClient: removeTelnetProtocolClient,
      options,
    });
  }
  return sshApplied === true;
}

function applyJmsProtocolClientPreference(options = {}) {
  return applyDeepLinkProtocolClientPreference({
    enabled: options.enabled,
    registerClient: registerJmsProtocolClient,
    removeClient: removeJmsProtocolClient,
    options,
  });
}

function updateDeepLinkEnabledPreference({
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

function updateSshDeepLinkEnabledPreference(options = {}) {
  return updateDeepLinkEnabledPreference(options);
}

function updateJmsDeepLinkEnabledPreference(options = {}) {
  return updateDeepLinkEnabledPreference(options);
}

function shouldDeliverDeepLink({ enabled = true, deliveryGeneration = 0, expectedGeneration = 0 } = {}) {
  return enabled !== false && deliveryGeneration === expectedGeneration;
}

function shouldDeliverSshDeepLink(options = {}) {
  return shouldDeliverDeepLink(options);
}

function shouldDeliverTelnetDeepLink(options = {}) {
  return shouldDeliverDeepLink(options);
}

function shouldDeliverJmsDeepLink(options = {}) {
  return shouldDeliverDeepLink(options);
}

function applyInitialDeepLinkPreference({
  enabled = true,
  applyPreference = () => false,
  clearPending,
  logWarn = console.warn,
  logLabel,
  warnOnFailure = true,
} = {}) {
  const requestedEnabled = enabled !== false;
  const success = applyPreference(requestedEnabled) === true;
  if (success) {
    return { enabled: requestedEnabled, success: true };
  }
  if (warnOnFailure && requestedEnabled) {
    logWarn(`[Main] Failed to apply saved ${logLabel} deep link preference.`);
  }
  if (requestedEnabled) {
    clearPending?.();
  }
  return { enabled: false, success: false };
}

function applyInitialSshDeepLinkPreference(options = {}) {
  return applyInitialDeepLinkPreference({
    ...options,
    logLabel: "ssh://",
    warnOnFailure: true,
  });
}

function applyInitialJmsDeepLinkPreference(options = {}) {
  return applyInitialDeepLinkPreference({
    ...options,
    logLabel: "jms://",
    warnOnFailure: false,
  });
}

module.exports = {
  SSH_DEEP_LINK_CHANNEL,
  TELNET_DEEP_LINK_CHANNEL,
  JMS_DEEP_LINK_CHANNEL,
  applyInitialJmsDeepLinkPreference,
  applyInitialSshDeepLinkPreference,
  applyJmsProtocolClientPreference,
  applySshProtocolClientPreference,
  collectJmsDeepLinkUrls,
  collectSshDeepLinkUrls,
  collectTelnetDeepLinkUrls,
  isJmsDeepLinkUrl,
  isSshDeepLinkUrl,
  isTelnetDeepLinkUrl,
  readJmsDeepLinkEnabledPreference,
  readSshDeepLinkEnabledPreference,
  registerJmsProtocolClient,
  registerSshProtocolClient,
  registerTelnetProtocolClient,
  removeJmsProtocolClient,
  removeSshProtocolClient,
  removeTelnetProtocolClient,
  shouldDeliverJmsDeepLink,
  shouldDeliverSshDeepLink,
  shouldDeliverTelnetDeepLink,
  updateJmsDeepLinkEnabledPreference,
  updateSshDeepLinkEnabledPreference,
  writeJmsDeepLinkEnabledPreference,
  writeSshDeepLinkEnabledPreference,
};
