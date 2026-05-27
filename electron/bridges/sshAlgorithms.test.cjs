const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { KexInit, HANDLERS: KEX_HANDLERS } = require("../../node_modules/ssh2/lib/protocol/kex.js");
const { COMPAT, COMPAT_CHECKS, MESSAGE } = require("../../node_modules/ssh2/lib/protocol/constants.js");

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

function kexPayloadFrom(init) {
  const payload = Buffer.alloc(1 + 16 + init.totalSize + 1 + 4);
  payload[0] = MESSAGE.KEXINIT;
  init.copyAllTo(payload, 17);
  return payload;
}

function buildKexInit(algorithms) {
  return new KexInit({
    kex: algorithms.kex,
    serverHostKey: algorithms.serverHostKey,
    cs: {
      cipher: algorithms.cipher,
      mac: algorithms.hmac,
      compress: algorithms.compress,
      lang: [],
    },
    sc: {
      cipher: algorithms.cipher,
      mac: algorithms.hmac,
      compress: algorithms.compress,
      lang: [],
    },
  });
}

function readLegacyGexRequestBits(compatFlags) {
  const algorithms = sshBridge.buildAlgorithms(true);
  const writtenPackets = [];
  const protocol = {
    _server: false,
    _compatFlags: compatFlags,
    _offer: buildKexInit(algorithms),
    _debug: undefined,
    _strictMode: undefined,
    _kex: undefined,
    _kexinit: Buffer.from("local-kexinit"),
    _identRaw: Buffer.from("SSH-2.0-netcatty-test"),
    _remoteIdentRaw: Buffer.from("SSH-2.0-Comware-5.20"),
    _packetRW: {
      write: {
        allocStartKEX: 0,
        alloc(size) {
          return Buffer.alloc(size);
        },
        finalize(packet) {
          return packet;
        },
      },
    },
    _cipher: {
      encrypt(packet) {
        writtenPackets.push(Buffer.from(packet));
      },
    },
  };
  const remote = buildKexInit({
    kex: ["diffie-hellman-group-exchange-sha1"],
    serverHostKey: ["ecdsa-sha2-nistp256", "ssh-rsa"],
    cipher: ["aes128-ctr"],
    hmac: ["hmac-sha2-256"],
    compress: ["none"],
  });

  KEX_HANDLERS[MESSAGE.KEXINIT](protocol, kexPayloadFrom(remote));

  const request = writtenPackets.find((packet) => packet[0] === MESSAGE.KEXDH_GEX_REQUEST);
  assert.ok(request, "expected a DH group-exchange request packet");
  return {
    min: request.readUInt32BE(1),
    preferred: request.readUInt32BE(5),
    max: request.readUInt32BE(9),
  };
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

test("Comware legacy group-exchange requests OpenSSH 6.4-sized DH groups", () => {
  const comwareCompatRule = COMPAT_CHECKS.find(([pattern, flags]) => (
    pattern instanceof RegExp
    && pattern.test("Comware-5.20")
    && (flags & COMPAT.COMWARE_DHGEX_1024)
  ));

  assert.ok(comwareCompatRule, "Comware servers should opt into the old DH group-exchange request size");
  assert.deepEqual(
    readLegacyGexRequestBits(COMPAT.COMWARE_DHGEX_1024),
    { min: 1024, preferred: 1024, max: 8192 },
  );
});

// --- skipEcdsaHostKey toggle (#1027) ---------------------------------------
// Some old Huawei / Cisco SSH stacks negotiate an ECDSA host key but produce
// signatures that ssh2's strict RFC verification rejects ("Handshake failed:
// signature verification failed"). Forcing the client to drop all
// ecdsa-sha2-* from its host key advertisement makes the negotiation fall
// back to ssh-rsa / ssh-dss / ssh-ed25519, which those stacks implement
// correctly.

for (const [label, buildAlgorithms] of [
  ["SSH", sshBridge.buildAlgorithms],
  ["SFTP", sftpBridge.buildSftpAlgorithms],
]) {
  test(`${label} skipEcdsaHostKey removes every ecdsa-sha2-* from serverHostKey (legacy on)`, () => {
    withAlgorithmRuntime({}, () => {
      const algorithms = buildAlgorithms(true, { skipEcdsaHostKey: true });
      assert.ok(algorithms.serverHostKey, "legacy mode must populate serverHostKey");
      for (const algo of algorithms.serverHostKey) {
        assert.ok(!algo.startsWith("ecdsa-sha2-"), `${algo} should be filtered out`);
      }
      // Non-ECDSA legacy host key algos must remain available.
      assert.ok(algorithms.serverHostKey.includes("ssh-rsa"));
      assert.ok(algorithms.serverHostKey.includes("ssh-dss"));
      assert.ok(algorithms.serverHostKey.includes("ssh-ed25519"));
    });
  });

  test(`${label} skipEcdsaHostKey also filters serverHostKey when legacy is off`, () => {
    withAlgorithmRuntime({}, () => {
      const algorithms = buildAlgorithms(false, { skipEcdsaHostKey: true });
      // Modern (non-legacy) mode delegates serverHostKey to ssh2 defaults
      // unless we explicitly populate the field. When the skip toggle is on,
      // we must populate it with the ssh2 defaults minus ecdsa-sha2-*.
      assert.ok(algorithms.serverHostKey, "skip toggle must populate serverHostKey");
      for (const algo of algorithms.serverHostKey) {
        assert.ok(!algo.startsWith("ecdsa-sha2-"), `${algo} should be filtered out`);
      }
    });
  });

  test(`${label} skipEcdsaHostKey leaves other algorithm categories untouched`, () => {
    withAlgorithmRuntime({}, () => {
      const reference = buildAlgorithms(true);
      const filtered = buildAlgorithms(true, { skipEcdsaHostKey: true });
      assert.deepEqual(filtered.kex, reference.kex);
      assert.deepEqual(filtered.cipher, reference.cipher);
      assert.deepEqual(filtered.hmac, reference.hmac);
      assert.deepEqual(filtered.compress, reference.compress);
    });
  });
}

// --- algorithmOverrides (per-host custom lists) ----------------------------
// Expert users can fully replace any individual algorithm category with their
// own ordered list. An empty / missing override leaves the category at the
// default (base ∪ legacy if enabled). Overrides apply BEFORE skipEcdsaHostKey
// so the skip toggle remains an unconditional kill switch.

for (const [label, buildAlgorithms] of [
  ["SSH", sshBridge.buildAlgorithms],
  ["SFTP", sftpBridge.buildSftpAlgorithms],
]) {
  test(`${label} algorithmOverrides.serverHostKey replaces the host-key list verbatim`, () => {
    withAlgorithmRuntime({}, () => {
      const algorithms = buildAlgorithms(true, {
        algorithmOverrides: { serverHostKey: ["ssh-rsa", "ssh-dss"] },
      });
      assert.deepEqual(algorithms.serverHostKey, ["ssh-rsa", "ssh-dss"]);
    });
  });

  test(`${label} algorithmOverrides apply to every category independently`, () => {
    withAlgorithmRuntime({}, () => {
      const algorithms = buildAlgorithms(false, {
        algorithmOverrides: {
          kex: ["curve25519-sha256"],
          cipher: ["aes256-ctr"],
          hmac: ["hmac-sha2-512"],
          serverHostKey: ["ssh-ed25519"],
          compress: ["none"],
        },
      });
      assert.deepEqual(algorithms.kex, ["curve25519-sha256"]);
      assert.deepEqual(algorithms.cipher, ["aes256-ctr"]);
      assert.deepEqual(algorithms.hmac, ["hmac-sha2-512"]);
      assert.deepEqual(algorithms.serverHostKey, ["ssh-ed25519"]);
      assert.deepEqual(algorithms.compress, ["none"]);
    });
  });

  test(`${label} empty or missing algorithmOverrides leave defaults intact`, () => {
    withAlgorithmRuntime({}, () => {
      const reference = buildAlgorithms(true);
      const withEmpty = buildAlgorithms(true, {
        algorithmOverrides: { kex: [], cipher: undefined },
      });
      assert.deepEqual(withEmpty.kex, reference.kex);
      assert.deepEqual(withEmpty.cipher, reference.cipher);
    });
  });

  test(`${label} skipEcdsaHostKey wins over algorithmOverrides that include ECDSA`, () => {
    withAlgorithmRuntime({}, () => {
      const algorithms = buildAlgorithms(false, {
        skipEcdsaHostKey: true,
        algorithmOverrides: {
          serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"],
        },
      });
      assert.deepEqual(algorithms.serverHostKey, ["ssh-ed25519", "ssh-rsa"]);
    });
  });

  test(`${label} HMAC override drops MD5 entries when the runtime disables MD5`, () => {
    // Mirrors the KEX-override-runtime-filter test above: a user might
    // seed an HMAC override from the legacy default list (which includes
    // hmac-md5) on a FIPS-disabled MD5 runtime. ssh2's
    // generateAlgorithmList() throws "Unsupported algorithm" synchronously
    // for hmac-md5 in that case, so the override path must apply the same
    // md5Supported() gate that applyLegacyHmacAlgorithms uses.
    withAlgorithmRuntime({ hashes: ["sha1", "sha256", "sha512"] }, () => {
      const algorithms = buildAlgorithms(true, {
        algorithmOverrides: {
          hmac: [
            "hmac-sha2-256",
            "hmac-md5",
            "hmac-sha1",
            "hmac-md5-96",
          ],
        },
      });
      assert.ok(algorithms.hmac.includes("hmac-sha2-256"));
      assert.ok(algorithms.hmac.includes("hmac-sha1"));
      assert.equal(algorithms.hmac.includes("hmac-md5"), false);
      assert.equal(algorithms.hmac.includes("hmac-md5-96"), false);
    });
  });

  test(`${label} KEX override is filtered against the runtime's fixed-DH support`, () => {
    // On Electron/BoringSSL where modp2 (the prime backing
    // diffie-hellman-group1-sha1) is not available, the default builder
    // already drops group1-sha1. An advanced user's KEX override that
    // includes it must go through the same filter — otherwise the
    // override silently re-introduces an algorithm ssh2 will throw
    // "Unknown DH group" on mid-handshake.
    withAlgorithmRuntime({ unsupportedGroups: new Set(["modp2"]) }, () => {
      const algorithms = buildAlgorithms(true, {
        algorithmOverrides: {
          kex: [
            "diffie-hellman-group14-sha1",
            "diffie-hellman-group1-sha1",
            "diffie-hellman-group-exchange-sha1",
          ],
        },
      });
      assert.ok(algorithms.kex.includes("diffie-hellman-group14-sha1"));
      assert.ok(algorithms.kex.includes("diffie-hellman-group-exchange-sha1"));
      assert.equal(algorithms.kex.includes("diffie-hellman-group1-sha1"), false);
    });
  });
}
