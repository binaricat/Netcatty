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

export const SUPPORTED_KEX_ALGORITHMS: readonly string[] = [
  "curve25519-sha256",
  "curve25519-sha256@libssh.org",
  "ecdh-sha2-nistp256",
  "ecdh-sha2-nistp384",
  "ecdh-sha2-nistp521",
  "diffie-hellman-group14-sha256",
  "diffie-hellman-group16-sha512",
  "diffie-hellman-group18-sha512",
  "diffie-hellman-group-exchange-sha256",
  "diffie-hellman-group14-sha1",
  "diffie-hellman-group1-sha1",
  "diffie-hellman-group-exchange-sha1",
];

export const SUPPORTED_CIPHER_ALGORITHMS: readonly string[] = [
  "chacha20-poly1305@openssh.com",
  "aes128-gcm@openssh.com",
  "aes256-gcm@openssh.com",
  "aes128-ctr",
  "aes192-ctr",
  "aes256-ctr",
  "aes128-cbc",
  "aes192-cbc",
  "aes256-cbc",
  "3des-cbc",
  "blowfish-cbc",
  "cast128-cbc",
  "arcfour256",
  "arcfour128",
  "arcfour",
];

export const SUPPORTED_HMAC_ALGORITHMS: readonly string[] = [
  "hmac-sha2-256-etm@openssh.com",
  "hmac-sha2-512-etm@openssh.com",
  "hmac-sha2-256",
  "hmac-sha2-512",
  "hmac-sha1-etm@openssh.com",
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
