const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { configureAppProfile } = require("./appProfile.cjs");

function fakeApp(t, isPackaged) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const production = path.join(tmp, "netcatty");
  const paths = { userData: production, sessionData: production };
  const app = {
    isPackaged,
    name: "Netcatty",
    setName(name) { this.name = name; },
    getPath(name) { return paths[name]; },
    setPath(name, value) {
      assert.ok(fs.statSync(value).isDirectory());
      paths[name] = value;
    },
  };
  return { app, paths, production };
}

test("unpackaged dist launches isolate both application and Chromium state", (t) => {
  const { app, paths, production } = fakeApp(t, false);
  assert.deepEqual(configureAppProfile(app, undefined), {
    isDev: false, effectiveDevServerUrl: undefined,
  });
  const dev = path.join(production, "dev");
  assert.deepEqual(paths, { userData: dev, sessionData: dev });
  assert.equal(app.name, "Netcatty Dev");
});

test("Vite launches keep the development profile and URL", (t) => {
  const { app, paths, production } = fakeApp(t, false);
  const url = "http://localhost:5173";
  assert.deepEqual(configureAppProfile(app, url), { isDev: true, effectiveDevServerUrl: url });
  const dev = path.join(production, "dev");
  assert.deepEqual(paths, { userData: dev, sessionData: dev });
});

test("packaged launches keep their data paths and ignore a Vite URL", (t) => {
  const { app, paths, production } = fakeApp(t, true);
  assert.deepEqual(configureAppProfile(app, "http://localhost:5173"), {
    isDev: false, effectiveDevServerUrl: undefined,
  });
  assert.deepEqual(paths, { userData: production, sessionData: production });
  assert.equal(app.name, "Netcatty");
});
