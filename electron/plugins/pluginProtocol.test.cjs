"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PluginProtocol,
  decodeRequestPath,
  readContainedFile,
} = require("./pluginProtocol.cjs");

function createRoots(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-protocol-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = {
    packageRoot: path.join(root, "package"),
    runtimeDirectory: path.join(root, "runtime"),
    sdkDirectory: path.join(root, "sdk"),
    contractDirectory: path.join(root, "contract"),
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(roots.packageRoot, "index.js"), "export default {};\n");
  fs.mkdirSync(path.join(roots.packageRoot, ".runtime"));
  fs.writeFileSync(path.join(roots.packageRoot, ".runtime", "index.js"), "export default {};\n");
  fs.writeFileSync(path.join(roots.runtimeDirectory, "browserRuntime.mjs"), "export {};\n");
  fs.writeFileSync(path.join(roots.sdkDirectory, "index.js"), "export {};\n");
  fs.writeFileSync(path.join(roots.contractDirectory, "index.js"), "export {};\n");
  return roots;
}

test("plugin URL decoding rejects traversal and platform separators", () => {
  assert.deepEqual(decodeRequestPath("/package/dist/index.js"), ["package", "dist", "index.js"]);
  for (const unsafe of ["/package/../escape", "/package/%2e%2e/escape", "/package/a%5cb", "/package//x"]) {
    assert.throws(() => decodeRequestPath(unsafe));
  }
});

test("contained resource reads reject symlink escape", async (context) => {
  if (process.platform === "win32") return;
  const roots = createRoots(context);
  const outside = path.join(path.dirname(roots.packageRoot), "outside.js");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(roots.packageRoot, "linked.js"));
  await assert.rejects(readContainedFile(roots.packageRoot, ["linked.js"]), /symlink outside/);
});

test("runtime-scoped protocol serves only registered package and host resources", async (context) => {
  const roots = createRoots(context);
  let handler;
  let unhandled = false;
  const fakeSession = {
    protocol: {
      handle(scheme, callback) {
        assert.equal(scheme, "netcatty-plugin");
        handler = callback;
      },
      unhandle(scheme) {
        assert.equal(scheme, "netcatty-plugin");
        unhandled = true;
      },
    },
  };
  const protocol = new PluginProtocol(roots);
  const sessionRegistration = protocol.registerSession(fakeSession);
  assert.throws(() => protocol.registerSession(fakeSession), /already registered/);
  const config = { pluginId: "com.example.test" };
  const registration = protocol.registerRuntime({
    pluginId: "com.example.test",
    packageRoot: roots.packageRoot,
    config,
  });

  const page = await handler({ method: "GET", url: registration.url });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /unsafe-inline/);
  assert.match(page.headers.get("content-security-policy"), /nonce-/);
  assert.match(page.headers.get("content-security-policy"), /worker-src 'none'/);
  assert.equal(page.headers.get("x-dns-prefetch-control"), "off");
  assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);
  const packageResponse = await handler({
    method: "GET",
    url: `netcatty-plugin://${registration.token}/package/index.js`,
  });
  assert.equal(await packageResponse.text(), "export default {};\n");
  const dotPackageResponse = await handler({
    method: "GET",
    url: `netcatty-plugin://${registration.token}/package/.runtime/index.js`,
  });
  assert.equal(dotPackageResponse.status, 200);
  assert.equal(await dotPackageResponse.text(), "export default {};\n");
  const configResponse = await handler({
    method: "GET",
    url: `netcatty-plugin://${registration.token}/__host/runtime/config.json`,
  });
  assert.deepEqual(await configResponse.json(), config);
  const otherRuntime = await handler({ method: "GET", url: "netcatty-plugin://unknown/package/index.js" });
  assert.equal(otherRuntime.status, 404);
  registration.dispose();
  assert.equal((await handler({ method: "GET", url: registration.url })).status, 404);
  sessionRegistration.dispose();
  sessionRegistration.dispose();
  assert.equal(unhandled, true);
});

test("browser runtime import maps accept reviewed host modules without protocol changes", async (context) => {
  const roots = createRoots(context);
  const uiDirectory = path.join(path.dirname(roots.packageRoot), "ui");
  fs.mkdirSync(uiDirectory);
  fs.writeFileSync(path.join(uiDirectory, "index.js"), "export const ui = true;\n");
  let handler;
  const protocol = new PluginProtocol({
    runtimeDirectory: roots.runtimeDirectory,
    moduleResources: [
      { specifier: "@netcatty/plugin-sdk", directory: roots.sdkDirectory },
      { specifier: "@netcatty/plugin-contract", directory: roots.contractDirectory },
      { specifier: "@netcatty/plugin-ui", directory: uiDirectory },
    ],
  });
  protocol.registerSession({
    protocol: {
      handle(_scheme, callback) { handler = callback; },
      unhandle() {},
    },
  });
  const registration = protocol.registerRuntime({
    pluginId: "com.example.modules",
    packageRoot: roots.packageRoot,
    config: {},
  });
  const page = await (await handler({ method: "GET", url: registration.url })).text();
  assert.match(page, /@netcatty\/plugin-ui/);
  assert.match(page, /__host\/modules\/m2\/index\.js/);
  const moduleResponse = await handler({
    method: "GET",
    url: `netcatty-plugin://${registration.token}/__host/modules/m2/index.js`,
  });
  assert.equal(await moduleResponse.text(), "export const ui = true;\n");
});
