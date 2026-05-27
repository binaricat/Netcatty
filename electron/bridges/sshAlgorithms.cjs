const crypto = require("node:crypto");

const FIXED_DH_GROUP_BY_KEX = Object.freeze({
  "diffie-hellman-group1-sha1": "modp2",
  "diffie-hellman-group14-sha1": "modp14",
  "diffie-hellman-group14-sha256": "modp14",
  "diffie-hellman-group16-sha512": "modp16",
  "diffie-hellman-group18-sha512": "modp18",
});

let _md5Supported = null;
const dhGroupSupport = new Map();

// MODP groups that every SSH runtime we target supports, so we skip the
// feature-detection probe for them. Under Electron's BoringSSL, instantiating a
// fixed DH group object purely to test support is pathologically slow — the
// 8192-bit modp18 alone takes ~20s on first call, freezing the first connection
// of every app launch — yet the probe always succeeds. We only feature-detect
// groups a runtime might genuinely drop (e.g. BoringSSL removed the weak
// 1024-bit group1/modp2); those fail their probe instantly, so it stays cheap.
const ASSUMED_SUPPORTED_DH_GROUPS = new Set(["modp14", "modp16", "modp18"]);

// FIPS-enabled OpenSSL builds disable MD5. Feature-detect once so the legacy
// algorithm list can skip hmac-md5 on those builds; ssh2 validates exact
// algorithm lists strictly and would otherwise throw "Unsupported algorithm"
// before the SSH handshake even starts.
function md5Supported() {
  if (_md5Supported === null) {
    try { _md5Supported = crypto.getHashes().includes("md5"); }
    catch { _md5Supported = false; }
  }
  return _md5Supported;
}

function fixedDhGroupSupported(groupName) {
  if (ASSUMED_SUPPORTED_DH_GROUPS.has(groupName)) return true;
  if (!dhGroupSupport.has(groupName)) {
    try {
      crypto.createDiffieHellmanGroup(groupName);
      dhGroupSupport.set(groupName, true);
    } catch {
      dhGroupSupport.set(groupName, false);
    }
  }
  return dhGroupSupport.get(groupName);
}

function filterSupportedFixedDhKex(kexAlgorithms) {
  return kexAlgorithms.filter((kexName) => {
    const groupName = FIXED_DH_GROUP_BY_KEX[kexName];
    return !groupName || fixedDhGroupSupported(groupName);
  });
}

function buildBaseAlgorithms() {
  return {
    cipher: [
      "aes128-gcm@openssh.com", "aes256-gcm@openssh.com",
      "aes128-ctr", "aes192-ctr", "aes256-ctr",
    ],
    kex: filterSupportedFixedDhKex([
      "curve25519-sha256", "curve25519-sha256@libssh.org",
      "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
      "diffie-hellman-group14-sha256",
      "diffie-hellman-group16-sha512", "diffie-hellman-group18-sha512",
      "diffie-hellman-group-exchange-sha256",
    ]),
    compress: ["none"],
  };
}

function applyLegacyAlgorithms(algorithms) {
  algorithms.kex.push(...filterSupportedFixedDhKex([
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
    "diffie-hellman-group-exchange-sha1",
  ]));
  algorithms.cipher.push(
    "aes128-cbc", "aes256-cbc", "3des-cbc",
  );
  algorithms.serverHostKey = [
    "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
    "rsa-sha2-512", "rsa-sha2-256",
    "ssh-rsa", "ssh-dss",
  ];
}

function applyLegacyHmacAlgorithms(algorithms) {
  // Legacy HMACs: required by very old servers (e.g. FreeBSD 6.1 OpenSSH
  // ~2006, issue #807). Without hmac-sha1/md5 in the offered list, the
  // handshake exchange-hash MAC never agrees and the host-key signature
  // verification that depends on it fails with
  // "Handshake failed: signature verification failed", which looks like
  // a host-key problem but is really a MAC negotiation mismatch.
  //
  // hmac-md5 is only appended when the local OpenSSL build actually
  // supports MD5. FIPS-enabled Node builds disable MD5 entirely, and
  // ssh2 strictly validates exact algorithm lists. Listing an unavailable
  // algorithm would throw "Unsupported algorithm" before any SSH
  // negotiation, turning the legacy toggle into a hard failure for FIPS
  // users. hmac-sha1 is allowed for HMAC even under FIPS 140-2 so it
  // stays unconditionally.
  // hmac-sha1-etm@openssh.com is in ssh2's default MAC set. Keep it so
  // hosts that only accept EtM SHA-1 MACs don't regress to "no matching
  // C->S MAC" when legacy mode replaces the default list.
  algorithms.hmac = [
    "hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com",
    "hmac-sha2-256", "hmac-sha2-512",
    "hmac-sha1-etm@openssh.com",
    "hmac-sha1",
  ];
  if (md5Supported()) {
    algorithms.hmac.push("hmac-md5");
  }
}

// Mirror of ssh2's DEFAULT_SERVER_HOST_KEY (see ssh2/lib/protocol/constants.js)
// minus every ecdsa-sha2-*. Used when skipEcdsaHostKey is on but legacy mode
// is off, so the field would otherwise be undefined and ssh2 would fall back
// to its built-in defaults (which still include ecdsa-sha2-*).
const MODERN_SERVER_HOST_KEY_WITHOUT_ECDSA = Object.freeze([
  "ssh-ed25519",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
]);

function applyEcdsaHostKeySkip(algorithms) {
  if (algorithms.serverHostKey) {
    algorithms.serverHostKey = algorithms.serverHostKey.filter(
      (algo) => !algo.startsWith("ecdsa-sha2-"),
    );
  } else {
    algorithms.serverHostKey = [...MODERN_SERVER_HOST_KEY_WITHOUT_ECDSA];
  }
}

// Categories the user can override via host.algorithms. Mirrors ssh2's
// algorithm-object shape (note ssh2 uses 'compress', not 'compression').
const OVERRIDABLE_CATEGORIES = Object.freeze([
  "kex", "cipher", "hmac", "serverHostKey", "compress",
]);

function filterRuntimeUnsupportedHmac(list) {
  if (md5Supported()) return list;
  // FIPS-enabled Node disables MD5. ssh2's generateAlgorithmList rejects
  // hmac-md5 / hmac-md5-96 against its SUPPORTED_MAC (filtered by
  // canUseMAC at startup) and throws "Unsupported algorithm" before any
  // SSH negotiation — drop those entries from a user override the same
  // way applyLegacyHmacAlgorithms gates the legacy seed.
  return list.filter((algo) => !algo.startsWith("hmac-md5"));
}

function applyAlgorithmOverrides(algorithms, overrides) {
  if (!overrides || typeof overrides !== "object") return;
  for (const key of OVERRIDABLE_CATEGORIES) {
    const list = overrides[key];
    if (Array.isArray(list) && list.length > 0) {
      // Copy so caller mutation cannot leak back into the host config object.
      const copy = list.slice();
      let filtered;
      if (key === "kex") {
        // KEX needs the same runtime fixed-DH support filter the default
        // builder applies — BoringSSL drops modp2 (the prime backing
        // `diffie-hellman-group1-sha1`), and an override that re-introduces
        // an unsupported group would make ssh2 throw "Unknown DH group"
        // mid-handshake instead of failing fast.
        filtered = filterSupportedFixedDhKex(copy);
      } else if (key === "hmac") {
        filtered = filterRuntimeUnsupportedHmac(copy);
      } else {
        filtered = copy;
      }
      algorithms[key] = filtered;
    }
  }
}

/**
 * Build SSH algorithm configuration.
 * When legacyEnabled is true, legacy algorithms are appended to each list
 * (lower priority than modern ones) for compatibility with older network equipment.
 *
 * @param {boolean} legacyEnabled
 * @param {{
 *   skipEcdsaHostKey?: boolean,
 *   algorithmOverrides?: Partial<Record<"kex"|"cipher"|"hmac"|"serverHostKey"|"compress", string[]>>,
 * }} [options]
 *   skipEcdsaHostKey: drop every ecdsa-sha2-* from the host-key advertisement.
 *     Useful when a server (e.g. old Huawei VRP) negotiates ECDSA but produces
 *     a signature that ssh2's strict RFC verification rejects — see #1027.
 *   algorithmOverrides: per-category replacement lists (advanced). When a
 *     category's array is non-empty, it fully replaces the negotiated list
 *     for that category. Applied BEFORE skipEcdsaHostKey.
 */
function buildAlgorithms(legacyEnabled, options = {}) {
  const algorithms = buildBaseAlgorithms();

  if (legacyEnabled) {
    applyLegacyAlgorithms(algorithms);
    applyLegacyHmacAlgorithms(algorithms);
  }

  // User overrides apply BEFORE the ECDSA kill switch so the latter remains
  // unconditional ("never advertise ECDSA on this host").
  applyAlgorithmOverrides(algorithms, options.algorithmOverrides);

  if (options.skipEcdsaHostKey) {
    applyEcdsaHostKeySkip(algorithms);
  }

  return algorithms;
}

/**
 * Build SSH algorithm configuration for SFTP connections.
 * When legacyEnabled is true, legacy algorithms are appended for older device compatibility.
 *
 * @param {boolean} legacyEnabled
 * @param {{ skipEcdsaHostKey?: boolean }} [options]
 */
function buildSftpAlgorithms(legacyEnabled, options = {}) {
  const algorithms = buildBaseAlgorithms();

  if (legacyEnabled) {
    applyLegacyAlgorithms(algorithms);
    applyLegacyHmacAlgorithms(algorithms);
  }

  // User overrides apply BEFORE the ECDSA kill switch so the latter remains
  // unconditional ("never advertise ECDSA on this host").
  applyAlgorithmOverrides(algorithms, options.algorithmOverrides);

  if (options.skipEcdsaHostKey) {
    applyEcdsaHostKeySkip(algorithms);
  }

  return algorithms;
}

function _resetAlgorithmSupportCacheForTests() {
  _md5Supported = null;
  dhGroupSupport.clear();
}

module.exports = {
  buildAlgorithms,
  buildSftpAlgorithms,
  _resetAlgorithmSupportCacheForTests,
};
