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
    "diffie-hellman-group-exchange-sha1",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
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

/**
 * Build SSH algorithm configuration.
 * When legacyEnabled is true, legacy algorithms are appended to each list
 * (lower priority than modern ones) for compatibility with older network equipment.
 */
function buildAlgorithms(legacyEnabled) {
  const algorithms = buildBaseAlgorithms();

  if (legacyEnabled) {
    applyLegacyAlgorithms(algorithms);
    applyLegacyHmacAlgorithms(algorithms);
  }

  return algorithms;
}

/**
 * Build SSH algorithm configuration for SFTP connections.
 * When legacyEnabled is true, legacy algorithms are appended for older device compatibility.
 */
function buildSftpAlgorithms(legacyEnabled) {
  const algorithms = buildBaseAlgorithms();

  if (legacyEnabled) {
    applyLegacyAlgorithms(algorithms);
    applyLegacyHmacAlgorithms(algorithms);
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
