/**
 * OpenSSH FIDO2 / U2F security-key (sk-*) helpers.
 *
 * Netcatty does not drive CTAP itself. SK keys authenticate through the system
 * OpenSSH agent + ssh-sk-helper (libfido2). These helpers detect sk material so
 * the app can force the agent path instead of software privateKey signing.
 */

export const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";
export const SK_ECDSA_NISTP256 = "sk-ecdsa-sha2-nistp256@openssh.com";

export type SkPublicKeyType = typeof SK_SSH_ED25519 | typeof SK_ECDSA_NISTP256;
export type FidoSshKeyType = "ED25519-SK" | "ECDSA-SK";

const SK_PUBLIC_KEY_TYPES = new Set<string>([SK_SSH_ED25519, SK_ECDSA_NISTP256]);

const OPENSSH_PRIVATE_KEY_RE =
  /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/;

export const isSkPublicKeyType = (type: string | undefined | null): type is SkPublicKeyType =>
  typeof type === "string" && SK_PUBLIC_KEY_TYPES.has(type.trim());

export const isFidoSshVaultKeyType = (
  type: string | undefined | null,
): type is FidoSshKeyType => type === "ED25519-SK" || type === "ECDSA-SK";

/** Parse the algorithm field from an OpenSSH authorized_keys / .pub line. */
export const extractOpenSshPublicKeyType = (
  publicKey: string | undefined | null,
): string | undefined => {
  if (typeof publicKey !== "string") return undefined;
  const line = publicKey
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("#"));
  if (!line) return undefined;
  // OpenSSH certificate algorithms embed `-cert-v01` *before* `@openssh.com`
  // (e.g. `sk-ssh-ed25519-cert-v01@openssh.com`), not after the RP id.
  const skCert = /^(sk-(?:ssh-ed25519|ecdsa-sha2-nistp256))-cert-v0[01]@openssh\.com\s+/.exec(line);
  if (skCert) return `${skCert[1]}@openssh.com`;
  const match = /^(sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com|ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp(?:256|384|521))(?:-cert-v0[01]@openssh\.com)?\s+/.exec(line);
  return match?.[1];
};

export const isSkPublicKey = (publicKey: string | undefined | null): boolean =>
  isSkPublicKeyType(extractOpenSshPublicKeyType(publicKey));

/**
 * Renderer-safe base64 decode. Avoids Node `Buffer`, which is unavailable in
 * Electron windows with `nodeIntegration: false`.
 */
const decodeBase64ToBinaryString = (payload: string): string | null => {
  const normalized = payload.replace(/\s+/g, "");
  if (!normalized) return null;
  try {
    if (typeof atob === "function") {
      return atob(normalized);
    }
  } catch {
    // fall through to Node Buffer when present (tests / main)
  }
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(normalized, "base64").toString("binary");
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Decode OpenSSH private-key PEM body (base64) for algorithm probing.
 * Real sk-* handles only contain `sk-*-@openssh.com` *inside* the base64 payload
 * (`@` is not a base64 alphabet character), so raw-text regex on PEM is insufficient.
 */
export const decodeOpenSshPrivateKeyBody = (
  privateKey: string | undefined | null,
): string | null => {
  if (typeof privateKey !== "string" || !privateKey.trim()) return null;
  const match = OPENSSH_PRIVATE_KEY_RE.exec(privateKey);
  if (!match) return null;
  return decodeBase64ToBinaryString(match[1]);
};

const skTypeInText = (text: string | undefined | null): FidoSshKeyType | undefined => {
  if (!text) return undefined;
  if (text.includes(SK_ECDSA_NISTP256) || /ecdsa-sk|sk-ecdsa/i.test(text)) return "ECDSA-SK";
  if (text.includes(SK_SSH_ED25519) || /ed25519-sk|sk-ssh-ed25519/i.test(text)) return "ED25519-SK";
  return undefined;
};

/**
 * Best-effort detection of an OpenSSH sk-* private key (handle) blob.
 * Decodes the base64 body and looks for the algorithm string.
 */
export const isSkPrivateKey = (privateKey: string | undefined | null): boolean => {
  if (typeof privateKey !== "string" || !privateKey.trim()) return false;
  const decoded = decodeOpenSshPrivateKeyBody(privateKey);
  if (decoded) {
    return decoded.includes(SK_SSH_ED25519) || decoded.includes(SK_ECDSA_NISTP256);
  }
  // Some exporters only put the type on a comment line / nearby text.
  return /sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com/.test(privateKey);
};

export const detectFidoSshKeyType = (args: {
  type?: string | null;
  publicKey?: string | null;
  privateKey?: string | null;
}): FidoSshKeyType | undefined => {
  if (isFidoSshVaultKeyType(args.type)) return args.type;
  const pubType = extractOpenSshPublicKeyType(args.publicKey);
  if (pubType === SK_SSH_ED25519) return "ED25519-SK";
  if (pubType === SK_ECDSA_NISTP256) return "ECDSA-SK";
  if (isSkPrivateKey(args.privateKey)) {
    const decoded = decodeOpenSshPrivateKeyBody(args.privateKey);
    return skTypeInText(decoded) || skTypeInText(args.privateKey) || "ED25519-SK";
  }
  return undefined;
};

/** True when vault/host material must authenticate via agent + hardware helper. */
export const requiresFidoSshAgentAuth = (args: {
  type?: string | null;
  publicKey?: string | null;
  privateKey?: string | null;
}): boolean => Boolean(detectFidoSshKeyType(args) || isSkPublicKey(args.publicKey) || isSkPrivateKey(args.privateKey));

export const fidoSshKeyTypeToOpenSsh = (type: FidoSshKeyType): SkPublicKeyType =>
  type === "ECDSA-SK" ? SK_ECDSA_NISTP256 : SK_SSH_ED25519;

export const openSshSkTypeToVaultKeyType = (type: string | undefined | null): FidoSshKeyType | undefined => {
  if (type === SK_SSH_ED25519) return "ED25519-SK";
  if (type === SK_ECDSA_NISTP256) return "ECDSA-SK";
  return undefined;
};
