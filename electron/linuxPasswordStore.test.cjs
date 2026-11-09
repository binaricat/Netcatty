const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  GNOME_LIBSECRET,
  PASSWORD_STORE_SWITCH,
  applyLinuxPasswordStore,
  defaultProbeSecretService,
  isKdePlasmaDesktop,
  parseNameHasOwnerOutput,
} = require("./linuxPasswordStore.cjs");

function createApp({ existingSwitch = false } = {}) {
  const appended = [];
  return {
    appended,
    app: {
      commandLine: {
        hasSwitch(name) {
          return existingSwitch && name === PASSWORD_STORE_SWITCH;
        },
        appendSwitch(name, value) {
          appended.push([name, value]);
        },
      },
    },
  };
}

function apply(overrides = {}, appOptions = {}) {
  const { app, appended } = createApp(appOptions);
  const applied = applyLinuxPasswordStore(app, {
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "niri" },
    probeSecretService: () => true,
    ...overrides,
  });
  return { applied, appended };
}

test("niri with Secret Service appends gnome-libsecret", () => {
  const { applied, appended } = apply({
    env: { XDG_CURRENT_DESKTOP: "niri" },
  });
  assert.equal(applied, true);
  assert.deepEqual(appended, [[PASSWORD_STORE_SWITCH, GNOME_LIBSECRET]]);
});

test("sway and Hyprland with Secret Service append gnome-libsecret", () => {
  for (const desktop of ["sway", "Hyprland"]) {
    const { applied, appended } = apply({
      env: { XDG_CURRENT_DESKTOP: desktop },
    });
    assert.equal(applied, true, desktop);
    assert.deepEqual(appended, [[PASSWORD_STORE_SWITCH, GNOME_LIBSECRET]], desktop);
  }
});

test("KDE and Plasma desktops do not append even when Secret Service is present", () => {
  for (const env of [
    { XDG_CURRENT_DESKTOP: "KDE" },
    { XDG_CURRENT_DESKTOP: "plasma" },
    { XDG_CURRENT_DESKTOP: "ubuntu:KDE" },
    { XDG_SESSION_DESKTOP: "plasma" },
  ]) {
    const { applied, appended } = apply({ env });
    assert.equal(applied, false, JSON.stringify(env));
    assert.deepEqual(appended, [], JSON.stringify(env));
  }
});

test("existing --password-store switch is left alone", () => {
  const { applied, appended } = apply({}, { existingSwitch: true });
  assert.equal(applied, false);
  assert.deepEqual(appended, []);
});

test("absent, throwing, or empty Secret Service probe does not append", () => {
  for (const probeSecretService of [
    () => false,
    () => {
      throw new Error("probe failed");
    },
  ]) {
    const { applied, appended } = apply({ probeSecretService });
    assert.equal(applied, false);
    assert.deepEqual(appended, []);
  }
});

test("non-Linux platforms do not append", () => {
  for (const platform of ["darwin", "win32"]) {
    const { applied, appended } = apply({ platform });
    assert.equal(applied, false, platform);
    assert.deepEqual(appended, [], platform);
  }
});

test("isKdePlasmaDesktop splits colon-separated desktop names", () => {
  assert.equal(isKdePlasmaDesktop({ XDG_CURRENT_DESKTOP: "niri" }), false);
  assert.equal(isKdePlasmaDesktop({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), false);
  assert.equal(isKdePlasmaDesktop({ XDG_CURRENT_DESKTOP: "ubuntu:KDE" }), true);
  assert.equal(isKdePlasmaDesktop({ XDG_SESSION_DESKTOP: "Plasma" }), true);
});

test("parseNameHasOwnerOutput understands busctl, gdbus, and dbus-send", () => {
  assert.equal(parseNameHasOwnerOutput("b true\n"), true);
  assert.equal(parseNameHasOwnerOutput("b false\n"), false);
  assert.equal(parseNameHasOwnerOutput("(true,)"), true);
  assert.equal(parseNameHasOwnerOutput("(false,)"), false);
  assert.equal(parseNameHasOwnerOutput("boolean true"), true);
  assert.equal(parseNameHasOwnerOutput("   boolean false"), false);
  assert.equal(parseNameHasOwnerOutput(""), false);
});

test("defaultProbeSecretService falls through missing binaries and reads the first reply", () => {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push(file);
    if (file === "busctl") {
      const err = new Error("not found");
      err.code = "ENOENT";
      throw err;
    }
    if (file === "gdbus") return "(true,)\n";
    throw new Error(`unexpected ${file}`);
  };
  assert.equal(defaultProbeSecretService({ execFileSync }), true);
  assert.deepEqual(calls, ["busctl", "gdbus"]);
});

test("defaultProbeSecretService is false when every helper fails", () => {
  assert.equal(defaultProbeSecretService({
    execFileSync() {
      throw new Error("missing");
    },
  }), false);
});

test("main.cjs applies the helper before app.whenReady()", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const helperIdx = source.indexOf('require("./linuxPasswordStore.cjs")');
  const callIdx = source.indexOf("applyLinuxPasswordStore(app)");
  const readyIdx = source.indexOf("app.whenReady()");
  assert.ok(helperIdx >= 0, "requires linuxPasswordStore.cjs");
  assert.ok(callIdx >= 0, "calls applyLinuxPasswordStore(app)");
  assert.ok(readyIdx >= 0, "has app.whenReady()");
  assert.ok(helperIdx < readyIdx, "require is before whenReady");
  assert.ok(callIdx < readyIdx, "call is before whenReady");
});
