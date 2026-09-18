const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const deepLink = require("./deepLink.cjs");
const { collectOpenTerminalPathArgs } = require("./openTerminalPath.cjs");

function createHarness() {
  const source = readFileSync(require.resolve("./main.cjs"), "utf8");
  const start = source.indexOf('app.on("second-instance"');
  const end = source.indexOf("// Application lifecycle", start);
  assert.ok(start >= 0 && end > start);
  let handle;
  const queued = [];
  const paths = [];
  let focusCount = 0;
  const context = vm.createContext({
    ...deepLink,
    app: { on: (_event, handler) => { handle = handler; } },
    sshDeepLinkEnabled: false,
    jmsDeepLinkEnabled: false,
    queueSshDeepLink: (url) => queued.push(url),
    queueTelnetDeepLink: (url) => queued.push(url),
    queueJmsDeepLink: (url) => queued.push(url),
    collectOpenTerminalPathArgs,
    resolveOpenTerminalPathsFromArgs: (argv, { baseDirectory }) => {
      paths.push({ argv: Array.from(argv), baseDirectory });
      return ["/resolved"];
    },
    queueResolvedOpenTerminalPaths: (resolved) => paths.push(Array.from(resolved)),
    focusMainWindow: () => { focusCount += 1; return true; },
  });
  vm.runInContext(source.slice(start, end), context);
  return { handle, queued, paths, focused: () => focusCount };
}

for (const password of ["secret", "space :/@ password", "-flag-like-password"]) {
  test(`second-instance transport copies are released without changing the SSH password: ${password}`, () => {
    const h = createHarness();
    const eventArgv = ["netcatty", "-ssh", "-P", "-pw", "alice@localhost", "2222", password];
    const additionalData = { rawLaunchArgv: ["-ssh", "alice@localhost", "-P", "2222", "-pw", password] };
    h.handle(null, eventArgv, "/working-directory", additionalData);
    assert.equal(h.queued.length, 1);
    const url = new URL(h.queued[0]);
    assert.equal(decodeURIComponent(url.password), password);
    assert.equal(url.hostname, "localhost");
    assert.equal(url.port, "2222");
    assert.equal(eventArgv.length, 0, "discard the consumed, potentially reordered event arguments");
    assert.equal(additionalData.rawLaunchArgv.length, 0, "discard the consumed forwarding copy");
  });
}

test("failed command-line parsing still clears temporary transport copies", () => {
  const h = createHarness();
  const eventArgv = ["netcatty", "-raw", "-pw", "localhost", "secret"];
  const additionalData = { rawLaunchArgv: ["-raw", "localhost", "-pw", "secret"] };
  h.handle(null, eventArgv, "/working-directory", additionalData);
  assert.deepEqual(h.queued, []);
  assert.equal(h.focused(), 1);
  assert.equal(eventArgv.length, 0);
  assert.equal(additionalData.rawLaunchArgv.length, 0);
});

test("legacy second instances without additional data retain ordered-argv support", () => {
  const h = createHarness();
  const eventArgv = ["netcatty", "-ssh", "alice@localhost", "-pw", "secret"];
  h.handle(null, eventArgv, "/working-directory");
  assert.equal(new URL(h.queued[0]).password, "secret");
  assert.equal(eventArgv.includes("secret"), false);
});

test("Explorer launch routing uses the ordered copy after transport cleanup", () => {
  const h = createHarness();
  const ordered = ["--open-terminal-path", "relative-folder"];
  const eventArgv = ["netcatty", ...ordered];
  const additionalData = { rawLaunchArgv: [...ordered] };
  h.handle(null, eventArgv, "/working-directory", additionalData);
  assert.deepEqual(h.paths, [
    { argv: ["netcatty", ...ordered], baseDirectory: "/working-directory" },
    ["/resolved"],
  ]);
  assert.equal(eventArgv.length, 0);
  assert.equal(additionalData.rawLaunchArgv.length, 0);
});

for (const useHandoff of [true, false]) {
  test(`reported SecureCRT 4A launch reaches the bastion and clears credentials (handoff=${useHandoff})`, () => {
    const h = createHarness();
    const args = ["/TITLEBAR", "192.0.2.10", "/N", "192.0.2.10", "/T", "/SSH2",
      "198.51.100.20", "/P", "2200", "/L", "alice", "/PASSWORD", "space :/@ password"];
    const argv = ["netcatty", ...args];
    const data = useHandoff ? { rawLaunchArgv: [...args] } : undefined;
    h.handle(null, argv, "/working-directory", data);
    assert.deepEqual(h.queued, ["ssh://alice:space%20%3A%2F%40%20password@198.51.100.20:2200"]);
    assert.equal(argv.includes("space :/@ password"), false);
    if (data) assert.equal(data.rawLaunchArgv.length, 0);
  });
}

test("legacy SecureCRT startup clears passwords after PuTTY-shaped metadata", () => {
  const h = createHarness();
  const argv = ["netcatty", "/SSH2", "/L", "-pw", "/TITLEBAR", "-pw", "/PASSWORD", "secret", "server.example.com"];
  h.handle(null, argv, "/working-directory");
  assert.deepEqual(h.queued, ["ssh://-pw:secret@server.example.com"]);
  assert.equal(argv.includes("secret"), false);
});
