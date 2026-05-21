const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const sshBridge = require("./sshBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");

const BASE_FIXED_DH_KEX = [
  "diffie-hellman-group14-sha256",
  "diffie-hellman-group16-sha512",
  "diffie-hellman-group18-sha512",
];

// Standard MODP groups we treat as supported without a runtime probe, because
// probing them via createDiffieHellmanGroup is pathologically slow under
// Electron's BoringSSL (~24s on first connection) yet always succeeds.
const ASSUMED_SUPPORTED_GROUPS = ["modp14", "modp16", "modp18"];

function resetSupportCache() {
  sshBridge._resetAlgorithmSupportCacheForTests?.();
  sftpBridge._resetAlgorithmSupportCacheForTests?.();
}

function withAlgorithmRuntime({ unsupportedGroups = new Set(), hashes = ["sha1", "sha256", "sha512", "md5"] }, callback) {
  const originalCreateGroup = crypto.createDiffieHellmanGroup;
  const originalGetHashes = crypto.getHashes;
  const probedGroups = [];

  crypto.createDiffieHellmanGroup = (name) => {
    probedGroups.push(name);
    if (unsupportedGroups.has(name)) {
      throw new Error("Unknown DH group");
    }
    return {};
  };
  crypto.getHashes = () => hashes;

  resetSupportCache();
  try {
    return callback({ probedGroups });
  } finally {
    crypto.createDiffieHellmanGroup = originalCreateGroup;
    crypto.getHashes = originalGetHashes;
    resetSupportCache();
  }
}

for (const [label, buildAlgorithms] of [
  ["SSH", sshBridge.buildAlgorithms],
  ["SFTP", sftpBridge.buildSftpAlgorithms],
]) {
  test(`${label} keeps standard DH groups without an expensive runtime probe`, () => {
    assert.equal(typeof buildAlgorithms, "function");

    // Even when the runtime claims it can't create the standard MODP groups,
    // they must stay in the offer list AND must never be passed to
    // createDiffieHellmanGroup — probing them is what froze the first
    // connection of every app launch for ~24s under BoringSSL.
    withAlgorithmRuntime({ unsupportedGroups: new Set(ASSUMED_SUPPORTED_GROUPS) }, ({ probedGroups }) => {
      const modernAlgorithms = buildAlgorithms(false);
      const legacyAlgorithms = buildAlgorithms(true);

      for (const kexName of BASE_FIXED_DH_KEX) {
        assert.ok(modernAlgorithms.kex.includes(kexName), `${kexName} should be offered`);
        assert.ok(legacyAlgorithms.kex.includes(kexName), `${kexName} should be offered (legacy)`);
      }
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group14-sha1"));

      for (const group of ASSUMED_SUPPORTED_GROUPS) {
        assert.ok(!probedGroups.includes(group), `${group} must not be feature-probed`);
      }
    });
  });

  test(`${label} drops group1-sha1 when the runtime lacks modp2`, () => {
    withAlgorithmRuntime({ unsupportedGroups: new Set(["modp2"]) }, () => {
      const legacyAlgorithms = buildAlgorithms(true);

      assert.equal(legacyAlgorithms.kex.includes("diffie-hellman-group1-sha1"), false);
      // Standard groups and the other legacy fallbacks must remain.
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group14-sha1"));
      for (const kexName of BASE_FIXED_DH_KEX) {
        assert.ok(legacyAlgorithms.kex.includes(kexName), `${kexName} should remain`);
      }
      assert.ok(legacyAlgorithms.kex.includes("diffie-hellman-group-exchange-sha1"));
    });
  });

  test(`${label} legacy group-exchange SHA-1 is the last KEX fallback`, () => {
    withAlgorithmRuntime({}, () => {
      const legacyKex = buildAlgorithms(true).kex;
      const group14Sha1Index = legacyKex.indexOf("diffie-hellman-group14-sha1");
      const group1Sha1Index = legacyKex.indexOf("diffie-hellman-group1-sha1");
      const groupExchangeSha1Index = legacyKex.indexOf("diffie-hellman-group-exchange-sha1");

      assert.notEqual(group14Sha1Index, -1);
      assert.notEqual(group1Sha1Index, -1);
      assert.notEqual(groupExchangeSha1Index, -1);
      assert.ok(group14Sha1Index < groupExchangeSha1Index);
      assert.ok(group1Sha1Index < groupExchangeSha1Index);
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
