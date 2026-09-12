const assert = require("node:assert/strict");
const test = require("node:test");

const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  collectSshDeepLinkQueueItems,
  redactPuttyCommandLinePasswords,
} = require("./deepLink.cjs");

test("second instance forwards its raw argv through the single-instance lock", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

  // Chromium regroups the second launch's command line into dash switches
  // followed by positional args, which splits PuTTY-style flags from their
  // values (-ssh host ... -P 22 -pw pass) and breaks the CLI parser. The
  // launching process therefore sends its own pristine argv slice as
  // additionalData (captured before passwords get redacted in place) and the
  // handler prefers it.
  assert.match(
    source,
    /app\.requestSingleInstanceLock\(\{ rawLaunchArgv: rawLaunchArgvForHandoff\.slice\(1\) \}\)/,
    "lock acquisition must forward the raw launch argv",
  );
  const redactIndex = source.indexOf("redactPuttyCommandLinePasswords(process.argv)");
  const snapshotIndex = source.indexOf("const rawLaunchArgvForHandoff");
  assert.notEqual(redactIndex, -1);
  assert.notEqual(snapshotIndex, -1);
  assert.ok(
    snapshotIndex < redactIndex,
    "the handoff argv snapshot must be captured before passwords are redacted",
  );
  const handlerIndex = source.indexOf('app.on("second-instance"');
  assert.notEqual(handlerIndex, -1, "second-instance handler must exist");
  const handlerSource = source.slice(handlerIndex, handlerIndex + 2000);
  assert.match(handlerSource, /additionalData\?\.rawLaunchArgv/);
  assert.match(handlerSource, /secondInstanceArgv/);
});

test("command-line PuTTY launches queue regardless of the ssh:// protocol-client preference", () => {
  // Warm second instance after the ssh:// protocol registration failed:
  // scheme URLs are dropped but the CLI connection must still be queued.
  const puttyItems = collectSshDeepLinkQueueItems(
    [
      String.raw`C:\Program Files\Netcatty\Netcatty.exe`,
      "-ssh",
      "alice@10.0.0.8",
      "-P",
      "2222",
      "-pw",
      "s3cret",
    ],
    { includeSchemeUrls: false },
  );
  assert.deepEqual(puttyItems, {
    ssh: [{ rawUrl: "ssh://alice:s3cret@10.0.0.8:2222", viaCommandLine: true }],
    telnet: [],
  });

  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Delivery bypasses the preference when the item came from the command line.
  const flushIndex = source.indexOf("async function flushPendingSshDeepLinks");
  assert.notEqual(flushIndex, -1);
  const flushSource = source.slice(
    flushIndex,
    source.indexOf("async function deliverOpenTerminalPath", flushIndex),
  );
  assert.match(flushSource, /viaCommandLine === true \|\| sshDeepLinkEnabled/);
  // The protocol registration failure path must not drop CLI launch intents.
  assert.match(source, /dropSchemePendingDeepLinks\(\)/);
});

test("failed protocol registration keeps command-line launch intents queued", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const initialIndex = source.indexOf("applyInitialSshDeepLinkPreference({");
  assert.notEqual(initialIndex, -1);
  const callSource = source.slice(initialIndex, initialIndex + 500);
  assert.match(callSource, /clearPending: \(\) => \{/);
  assert.match(callSource, /dropSchemePendingDeepLinks\(\)/);
});

for (const gotLock of [true, false]) {
  test(`launch password snapshot is released after handoff (primary=${gotLock})`, () => {
    const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const snapshotStart = source.indexOf("const rawLaunchArgvForHandoff");
    const snapshotEnd = source.indexOf("const pendingOpenTerminalPaths", snapshotStart);
    const lockStart = source.indexOf("const gotLock = app.requestSingleInstanceLock");
    const lockEnd = source.indexOf("if (!gotLock)", lockStart);
    assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
    assert.ok(lockStart >= 0 && lockEnd > lockStart);
    const argv = ["netcatty", "-ssh", "alice@localhost", "-pw", "test password:@"];
    let handedOff;
    const context = vm.createContext({
      process: { argv },
      redactPuttyCommandLinePasswords,
      app: {
        requestSingleInstanceLock(data) {
          // Electron serializes additionalData synchronously in this call.
          handedOff = JSON.parse(JSON.stringify(data));
          return gotLock;
        },
      },
    });
    vm.runInContext([
      source.slice(snapshotStart, snapshotEnd),
      source.slice(lockStart, lockEnd),
      "globalThis.remainingArgs = rawLaunchArgvForHandoff.length;",
    ].join("\n"), context);
    assert.equal(handedOff.rawLaunchArgv.at(-1), "test password:@", "forward the real password");
    assert.notEqual(argv.at(-1), "test password:@", "scrub process.argv");
    assert.equal(context.remainingArgs, 0, "do not retain a plaintext handoff snapshot");
  });
}
