"use strict";

/**
 * Resolve the `defaultPath` handed to native open/save dialogs.
 *
 * Callers that do not pass any directory options keep their legacy behavior
 * (the raw `defaultPath` is forwarded untouched). Callers that opt in can ask
 * for a preferred local directory (for example the user's configured SFTP
 * download folder) with a well-known fallback such as the system Downloads
 * folder. Without a directory the OS picks where the dialog opens, which on
 * Windows can be the application install directory (#4353).
 */

const FALLBACK_DIRECTORY_NAMES = new Set(["downloads"]);

function isExistingDirectory(fs, candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function normalizeDirectoryOptions(options) {
  if (!options || typeof options !== "object") return null;
  const preferredDirectory = typeof options.preferredDirectory === "string"
    ? options.preferredDirectory.trim()
    : "";
  const fallbackDirectory = typeof options.fallbackDirectory === "string"
    && FALLBACK_DIRECTORY_NAMES.has(options.fallbackDirectory)
    ? options.fallbackDirectory
    : null;
  if (!preferredDirectory && !fallbackDirectory) return null;
  return { preferredDirectory, fallbackDirectory };
}

function resolveFallbackDirectory(app, name) {
  if (!name || !app || typeof app.getPath !== "function") return null;
  try {
    const resolved = app.getPath(name);
    return typeof resolved === "string" && resolved ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Pick the directory a dialog should open in.
 * @returns {string | null} An existing absolute directory, or null.
 */
function resolveDialogDirectory(options, { app, fs, path }) {
  const normalized = normalizeDirectoryOptions(options);
  if (!normalized) return null;
  const { preferredDirectory, fallbackDirectory } = normalized;
  if (
    preferredDirectory
    && path.isAbsolute(preferredDirectory)
    && isExistingDirectory(fs, preferredDirectory)
  ) {
    return preferredDirectory;
  }
  const fallback = resolveFallbackDirectory(app, fallbackDirectory);
  if (fallback && path.isAbsolute(fallback) && isExistingDirectory(fs, fallback)) {
    return fallback;
  }
  return null;
}

function isBareFileName(path, value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && path.basename(value) === value;
}

/**
 * Resolve the `defaultPath` for `dialog.showSaveDialog`.
 * A bare file name is placed inside the resolved directory; an explicit path
 * (or a call without directory options) is returned unchanged.
 */
function resolveSaveDialogDefaultPath(defaultPath, options, deps) {
  const legacy = typeof defaultPath === "string" ? defaultPath : undefined;
  const directory = resolveDialogDirectory(options, deps);
  if (!directory) return legacy;
  if (legacy === undefined || legacy === "") return directory;
  if (!isBareFileName(deps.path, legacy)) return legacy;
  return deps.path.join(directory, legacy);
}

/**
 * Resolve the `defaultPath` for directory pickers. An explicit `defaultPath`
 * always wins; otherwise the resolved directory (if any) is used.
 */
function resolveDirectoryDialogDefaultPath(defaultPath, options, deps) {
  if (typeof defaultPath === "string" && defaultPath) return defaultPath;
  return resolveDialogDirectory(options, deps) ?? undefined;
}

module.exports = {
  resolveDialogDirectory,
  resolveSaveDialogDefaultPath,
  resolveDirectoryDialogDefaultPath,
};
