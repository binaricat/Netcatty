const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const sshBridge = require("./sshBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");

const FIXED_DH_GROUP_BY_KEX = new Map([
  ["diffie-hellman-group1-sha1", "modp2"],
  ["diffie-hellman-group14-sha1", "modp14"],
  ["diffie-hellman-group14-sha256", "modp14"],
  ["diffie-hellman-group16-sha512", "modp16"],
  ["diffie-hellman-group18-sha512", "modp18"],
]);

function resetSupportCache() {
  sshBridge._resetAlgorithmSupportCacheForTests?.();
  sftpBridge._resetAlgorithmSupportCacheForTests?.();
}

function withUnsupportedDhGroups(unsupportedGroups, callback) {
  const originalCreateGroup = crypto.createDiffieHellmanGroup;
  crypto.createDiffieHellmanGroup = (name, ...args) => {
    if (unsupportedGroups.has(name)) {
      throw new Error("Unknown DH group");
    }
    return originalCreateGroup.call(crypto, name, ...args);
  };

  resetSupportCache();
  try {
    return callback();
  } finally {
    crypto.createDiffieHellmanGroup = originalCreateGroup;
    resetSupportCache();
  }
}

function assertNoUnsupportedFixedDhKex(algorithms, unsupportedGroups) {
  for (const [kexName, groupName] of FIXED_DH_GROUP_BY_KEX) {
    assert.equal(
      algorithms.kex.includes(kexName),
      !unsupportedGroups.has(groupName),
      `${kexName} should match ${groupName} runtime support`,
    );
  }
}

for (const [label, buildAlgorithms] of [
  ["SSH", sshBridge.buildAlgorithms],
  ["SFTP", sftpBridge.buildSftpAlgorithms],
]) {
  test(`${label} algorithms skip fixed DH groups unsupported by the runtime`, () => {
    assert.equal(typeof buildAlgorithms, "function");

    withUnsupportedDhGroups(new Set(["modp16", "modp18"]), () => {
      const algorithms = buildAlgorithms(true);

      assertNoUnsupportedFixedDhKex(algorithms, new Set(["modp16", "modp18"]));
      assert.ok(algorithms.kex.includes("diffie-hellman-group-exchange-sha256"));
      assert.ok(algorithms.kex.includes("diffie-hellman-group14-sha1"));
      assert.ok(algorithms.kex.includes("diffie-hellman-group1-sha1"));
    });
  });
}
