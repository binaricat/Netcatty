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

const BASE_FIXED_DH_KEX = [
  "diffie-hellman-group14-sha256",
  "diffie-hellman-group16-sha512",
  "diffie-hellman-group18-sha512",
];

const LEGACY_FIXED_DH_KEX = [
  "diffie-hellman-group14-sha1",
  "diffie-hellman-group1-sha1",
];

function resetSupportCache() {
  sshBridge._resetAlgorithmSupportCacheForTests?.();
  sftpBridge._resetAlgorithmSupportCacheForTests?.();
}

function withAlgorithmRuntime({ unsupportedGroups = new Set(), hashes = ["sha1", "sha256", "sha512", "md5"] }, callback) {
  const originalCreateGroup = crypto.createDiffieHellmanGroup;
  const originalGetHashes = crypto.getHashes;

  crypto.createDiffieHellmanGroup = (name) => {
    if (unsupportedGroups.has(name)) {
      throw new Error("Unknown DH group");
    }
    return {};
  };
  crypto.getHashes = () => hashes;

  resetSupportCache();
  try {
    return callback();
  } finally {
    crypto.createDiffieHellmanGroup = originalCreateGroup;
    crypto.getHashes = originalGetHashes;
    resetSupportCache();
  }
}

function assertFixedDhKexSupport(algorithms, expectedKexNames, unsupportedGroups) {
  const expectedKex = new Set(expectedKexNames);

  for (const [kexName, groupName] of FIXED_DH_GROUP_BY_KEX) {
    assert.equal(
      algorithms.kex.includes(kexName),
      expectedKex.has(kexName) && !unsupportedGroups.has(groupName),
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

    withAlgorithmRuntime({ unsupportedGroups: new Set(["modp16", "modp18"]) }, () => {
      const modernAlgorithms = buildAlgorithms(false);
      const legacyAlgorithms = buildAlgorithms(true);

      assertFixedDhKexSupport(modernAlgorithms, BASE_FIXED_DH_KEX, new Set(["modp16", "modp18"]));
      assertFixedDhKexSupport(
        legacyAlgorithms,
        [...BASE_FIXED_DH_KEX, ...LEGACY_FIXED_DH_KEX],
        new Set(["modp16", "modp18"]),
      );
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group-exchange-sha256"));
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group-exchange-sha1"));
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group14-sha1"));
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group1-sha1"));
    });
  });
}

test("SFTP legacy HMAC algorithms match SSH legacy compatibility", () => {
  withAlgorithmRuntime({}, () => {
    const sshAlgorithms = sshBridge.buildAlgorithms(true);
    const sftpAlgorithms = sftpBridge.buildSftpAlgorithms(true);

    assert.deepEqual(sftpAlgorithms.hmac, sshAlgorithms.hmac);
    assert.ok(sftpAlgorithms.hmac.includes("hmac-md5"));
  });
});

test("legacy HMAC algorithms skip MD5 when the runtime disables it", () => {
  withAlgorithmRuntime({ hashes: ["sha1", "sha256", "sha512"] }, () => {
    for (const algorithms of [
      sshBridge.buildAlgorithms(true),
      sftpBridge.buildSftpAlgorithms(true),
    ]) {
      assert.ok(algorithms.hmac.includes("hmac-sha1"));
      assert.equal(algorithms.hmac.includes("hmac-md5"), false);
    }
  });
});
