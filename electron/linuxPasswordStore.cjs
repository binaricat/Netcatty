/**
 * Pick Chromium's Linux password store before app.whenReady().
 *
 * Chromium sniffs XDG_CURRENT_DESKTOP and only enables gnome-libsecret /
 * kwallet for GNOME-family and KDE/Plasma names. Other compositors
 * (niri, sway, Hyprland, …) fall through to BASIC_TEXT even when
 * Secret Service is running, so safeStorage.isEncryptionAvailable()
 * is false (#4189).
 *
 * Must run before app.whenReady(); Electron ignores --password-store
 * afterwards.
 */

const { execFileSync } = require("node:child_process");

const SECRET_SERVICE_NAME = "org.freedesktop.secrets";
const PASSWORD_STORE_SWITCH = "password-store";
const GNOME_LIBSECRET = "gnome-libsecret";
const DEFAULT_PROBE_TIMEOUT_MS = 1000;

const SECRET_SERVICE_PROBE_COMMANDS = [
  {
    file: "busctl",
    args: [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      SECRET_SERVICE_NAME,
    ],
  },
  {
    file: "gdbus",
    args: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      SECRET_SERVICE_NAME,
    ],
  },
  {
    file: "dbus-send",
    args: [
      "--session",
      "--print-reply=literal",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner",
      `string:${SECRET_SERVICE_NAME}`,
    ],
  },
];

function desktopTokens(env = process.env) {
  const raw = [env?.XDG_CURRENT_DESKTOP, env?.XDG_SESSION_DESKTOP]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(":");
  return raw
    .split(":")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function isKdePlasmaDesktop(env = process.env) {
  return desktopTokens(env).some((token) => token === "kde" || token === "plasma");
}

function parseNameHasOwnerOutput(stdout) {
  const text = String(stdout ?? "");
  if (/\bfalse\b/i.test(text)) return false;
  if (/\btrue\b/i.test(text)) return true;
  return false;
}

function defaultProbeSecretService(options = {}) {
  const run = options.execFileSync ?? execFileSync;
  const timeout = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  for (const command of SECRET_SERVICE_PROBE_COMMANDS) {
    try {
      const stdout = run(command.file, command.args, {
        encoding: "utf8",
        timeout,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseNameHasOwnerOutput(stdout);
    } catch {
      // Missing binary, timeout, or D-Bus error: try the next helper.
    }
  }
  return false;
}

function applyLinuxPasswordStore(app, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return false;
  if (!app?.commandLine) return false;

  const env = options.env ?? process.env;
  const hasSwitch = options.hasSwitch
    ?? ((name) => Boolean(app.commandLine.hasSwitch?.(name)));
  const appendSwitch = options.appendSwitch
    ?? ((name, value) => app.commandLine.appendSwitch(name, value));

  if (hasSwitch(PASSWORD_STORE_SWITCH)) return false;
  if (isKdePlasmaDesktop(env)) return false;

  let available = false;
  try {
    const probe = options.probeSecretService ?? defaultProbeSecretService;
    available = Boolean(probe({
      execFileSync: options.execFileSync,
      timeoutMs: options.timeoutMs,
    }));
  } catch {
    return false;
  }
  if (!available) return false;

  appendSwitch(PASSWORD_STORE_SWITCH, GNOME_LIBSECRET);
  return true;
}

module.exports = {
  SECRET_SERVICE_NAME,
  PASSWORD_STORE_SWITCH,
  GNOME_LIBSECRET,
  applyLinuxPasswordStore,
  isKdePlasmaDesktop,
  parseNameHasOwnerOutput,
  defaultProbeSecretService,
};
