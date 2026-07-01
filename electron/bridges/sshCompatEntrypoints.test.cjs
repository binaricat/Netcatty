const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

function assertSsh2LoadsAfterCompat(modulePath) {
  const script = `
    const assert = require("node:assert/strict");
    const crypto = require("node:crypto");
    const Module = require("node:module");
    const originalLoad = Module._load;
    const hits = [];
    Module._load = function(request, parent, isMain) {
      if (request === "ssh2" || request.startsWith("ssh2/") || request === "ssh2-sftp-client") {
        hits.push({
          request,
          installed: crypto.createDiffieHellmanGroup.__boringSslDhCompat === true,
        });
      }
      return originalLoad.apply(this, arguments);
    };
    require(${JSON.stringify(modulePath)});
    Module._load = originalLoad;
    assert.ok(hits.length > 0, "expected the entrypoint to load ssh2");
    assert.deepEqual(hits.filter((hit) => !hit.installed), []);
  `;
  execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: "pipe",
  });
}

for (const [label, modulePath] of [
  ["SSH bridge", "./electron/bridges/sshBridge.cjs"],
  ["SFTP bridge", "./electron/bridges/sftpBridge.cjs"],
  ["Port forwarding bridge", "./electron/bridges/portForwardingBridge.cjs"],
]) {
  test(`${label} installs DH compatibility before loading ssh2`, () => {
    assertSsh2LoadsAfterCompat(modulePath);
  });
}
