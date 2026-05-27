/**
 * User-selectable SSH algorithm lists for the host-level "advanced
 * algorithm overrides" UI. These lists must remain a subset of the
 * algorithms ssh2 actually supports (see `ssh2/lib/protocol/constants.js`);
 * passing an algorithm outside that set causes ssh2 to throw
 * "Unsupported algorithm" before the SSH handshake even starts.
 *
 * Order in each array is the suggested display / default-priority order
 * (modern + secure first). When the user picks a subset, that subset
 * fully replaces the negotiated list for the category.
 */

export type SSHAlgorithmCategory =
  | "kex"
  | "cipher"
  | "hmac"
  | "serverHostKey"
  | "compress";

// IMPORTANT: every algorithm in these lists must also appear in ssh2's
// `SUPPORTED_*` constant (see `node_modules/ssh2/lib/protocol/constants.js`).
// ssh2 throws `Unsupported algorithm` synchronously from `Client.connect()`
// when it sees an algorithm outside its supported set, so exposing a dead
// choice in the UI would make a host unreachable the moment the user
// saved it.
//
// In particular, OpenSSL 3 disabled `blowfish`, `cast128`, and the
// `arcfour` family — ssh2's `canUseCipher` filter then drops them from
// `SUPPORTED_CIPHER` at startup. They are intentionally absent below.
// `sshAlgorithmList.test.ts` enforces the subset invariant.

export const SUPPORTED_KEX_ALGORITHMS: readonly string[] = [
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
  "diffie-hellman-group-exchange-sha256",
  "diffie-hellman-group14-sha256",
  "diffie-hellman-group15-sha512",
  "diffie-hellman-group16-sha512",
  "diffie-hellman-group17-sha512",
  "diffie-hellman-group18-sha512",
  "diffie-hellman-group-exchange-sha1",
  "diffie-hellman-group14-sha1",
  "diffie-hellman-group1-sha1",
];

export const SUPPORTED_CIPHER_ALGORITHMS: readonly string[] = [
  "chacha20-poly1305@openssh.com",
  "aes128-gcm@openssh.com",
  "aes256-gcm@openssh.com",
  "aes128-gcm",
  "aes256-gcm",
  "aes128-ctr",
  "aes192-ctr",
  "aes256-ctr",
  "aes128-cbc",
  "aes192-cbc",
  "aes256-cbc",
  "3des-cbc",
];

export const SUPPORTED_HMAC_ALGORITHMS: readonly string[] = [
  "hmac-sha2-256-etm@openssh.com",
  "hmac-sha2-512-etm@openssh.com",
  "hmac-sha1-etm@openssh.com",
  "hmac-sha2-256",
  "hmac-sha2-512",
  "hmac-sha1",
  "hmac-sha2-256-96",
  "hmac-sha2-512-96",
  "hmac-sha1-96",
  "hmac-md5",
  "hmac-md5-96",
  "hmac-ripemd160",
];

export const SUPPORTED_SERVER_HOST_KEY_ALGORITHMS: readonly string[] = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
  "ssh-rsa",
  "ssh-dss",
];

export const SUPPORTED_COMPRESS_ALGORITHMS: readonly string[] = [
  "none",
  "zlib@openssh.com",
  "zlib",
];

export const SUPPORTED_ALGORITHMS_BY_CATEGORY: Readonly<Record<SSHAlgorithmCategory, readonly string[]>> = {
  kex: SUPPORTED_KEX_ALGORITHMS,
  cipher: SUPPORTED_CIPHER_ALGORITHMS,
  hmac: SUPPORTED_HMAC_ALGORITHMS,
  serverHostKey: SUPPORTED_SERVER_HOST_KEY_ALGORITHMS,
  compress: SUPPORTED_COMPRESS_ALGORITHMS,
};

export const SSH_ALGORITHM_CATEGORIES: readonly SSHAlgorithmCategory[] = [
  "kex",
  "cipher",
  "hmac",
  "serverHostKey",
  "compress",
];

// Mirror of what `electron/bridges/sshAlgorithms.cjs#buildAlgorithms(false)`
// actually emits in non-legacy mode. Used by the UI to seed a category's
// first customization with the *current effective default* rather than the
// full SUPPORTED list — otherwise unchecking a single modern algorithm
// would inadvertently introduce CBC / arcfour / MD5 into the offer list.
//
// `hmac` and `serverHostKey` here mirror ssh2's `DEFAULT_MAC` and
// `DEFAULT_SERVER_HOST_KEY` because non-legacy mode leaves both fields
// unset, letting ssh2 fall back to those defaults. Keep them in sync if
// the ssh2 dependency bumps.
const MODERN_DEFAULT_ALGORITHMS: Readonly<Record<SSHAlgorithmCategory, readonly string[]>> = {
  kex: [
    "curve25519-sha256",
    "curve25519-sha256@libssh.org",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
    "diffie-hellman-group14-sha256",
    "diffie-hellman-group16-sha512",
    "diffie-hellman-group18-sha512",
    "diffie-hellman-group-exchange-sha256",
  ],
  cipher: [
    "aes128-gcm@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
  ],
  hmac: [
    "hmac-sha2-256-etm@openssh.com",
    "hmac-sha2-512-etm@openssh.com",
    "hmac-sha1-etm@openssh.com",
    "hmac-sha2-256",
    "hmac-sha2-512",
    "hmac-sha1",
  ],
  serverHostKey: [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
  ],
  compress: ["none"],
};

// Additions appended when legacy mode is on — matches
// `applyLegacyAlgorithms` + `applyLegacyHmacAlgorithms` in
// `electron/bridges/sshAlgorithms.cjs`. `hmac-md5` is conditional on
// runtime support there but we seed it unconditionally; ssh2 will surface
// "Unsupported algorithm" at connect time on FIPS Node builds, which is
// acceptable as a UI hint that the user picked something the runtime
// rejects.
const LEGACY_DEFAULT_ADDITIONS: Partial<Record<SSHAlgorithmCategory, readonly string[]>> = {
  kex: [
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
    "diffie-hellman-group-exchange-sha1",
  ],
  cipher: ["aes128-cbc", "aes256-cbc", "3des-cbc"],
  hmac: ["hmac-md5"],
  serverHostKey: ["ssh-dss"],
};

/**
 * Return the algorithm list that NetCatty would actually offer for each
 * category at connect time given the current legacy toggle. The advanced
 * override UI seeds an untouched category from this list so a partial
 * customization can't accidentally re-enable algorithms the connection
 * wouldn't otherwise advertise.
 */
export function effectiveDefaultAlgorithms(
  legacyEnabled: boolean,
): Record<SSHAlgorithmCategory, readonly string[]> {
  const result: Record<SSHAlgorithmCategory, string[]> = {
    kex: [...MODERN_DEFAULT_ALGORITHMS.kex],
    cipher: [...MODERN_DEFAULT_ALGORITHMS.cipher],
    hmac: [...MODERN_DEFAULT_ALGORITHMS.hmac],
    serverHostKey: [...MODERN_DEFAULT_ALGORITHMS.serverHostKey],
    compress: [...MODERN_DEFAULT_ALGORITHMS.compress],
  };
  if (legacyEnabled) {
    for (const category of SSH_ALGORITHM_CATEGORIES) {
      const additions = LEGACY_DEFAULT_ADDITIONS[category];
      if (!additions) continue;
      for (const algo of additions) {
        if (!result[category].includes(algo)) result[category].push(algo);
      }
    }
  }
  return result;
}
