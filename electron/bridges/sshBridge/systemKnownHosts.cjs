/**
 * System OpenSSH known_hosts trust source.
 *
 * Mosh sessions are bootstrapped by the *system* `ssh`, which records the
 * server's host key in the user's OpenSSH known_hosts files (e.g.
 * `~/.ssh/known_hosts`). That file — not Netcatty's in-app known-hosts vault —
 * is the real trust source for a Mosh connection: the user vetted and accepted
 * the key through OpenSSH's own prompt during the handshake.
 *
 * The stats companion (moshStatsConnection.cjs) opens a *second*, background
 * ssh2 connection and must only ever ride on a host whose key is already
 * trusted. Netcatty's vault snapshot does not get updated when OpenSSH accepts
 * a key, so a host trusted purely via the system would be wrongly classified as
 * "unknown" and the companion permanently disabled (issue: Mosh stats never
 * appear unless the user manually imports/scans the host into Netcatty).
 *
 * This module parses the system known_hosts files and answers a single
 * question: "does a non-revoked system entry for this (host, port) record the
 * EXACT public key the server just presented?" — matched by the key's SHA-256
 * fingerprint. It only ever *adds* trust for keys the user's own OpenSSH
 * already trusts; it never accepts an unknown or mismatched key. Unknown /
 * changed keys remain rejected by the caller.
 *
 * Format handling (OpenSSH known_hosts(5)):
 *   - comments (`#…`) and blank lines are ignored;
 *   - plain host tokens, comma-separated host lists, and `[host]:port`;
 *   - hashed entries `|1|<b64 salt>|<b64 HMAC-SHA1(salt, token)>` — the token
 *     hashed is the canonical name OpenSSH uses (`[host]:port` for a non-default
 *     port, the bare host otherwise), matched by recomputing the HMAC;
 *   - marker lines: `@revoked` entries are treated as explicitly NOT trusted
 *     (a revoked key never grants trust, even if its fingerprint matches);
 *     `@cert-authority` lines are skipped (they delegate to a CA, not a literal
 *     host key, which the fingerprint-equality check cannot model);
 *   - multiple key types / multiple lines per host.
 *
 * Negation patterns (`!pattern`) and wildcard patterns (`*`, `?`) are NOT
 * honored for matching: a wildcard could make an unrelated entry vouch for a
 * host whose key we have not actually seen. We only trust exact host-token
 * matches, which is the safe subset for "has the user's OpenSSH seen THIS key
 * for THIS host". This is intentionally conservative — failing to match just
 * leaves the Mosh stats bar empty (graceful degradation), never weakens
 * security.
 */
function createSystemKnownHostsApi(ctx) {
  const { fs, path, os, crypto, log } = ctx;

  const HASH_MARKER = "|1|";

  const normalizeHostname = (value) => String(value || "").trim().toLowerCase();

  const stripFingerprintPadding = (value) =>
    String(value || "").replace(/=+$/g, "");

  // SHA-256 base64 fingerprint (no padding) of an OpenSSH public-key blob,
  // computed the same way the live host-key verifier does so the two values
  // are directly comparable.
  const fingerprintFromKeyBlob = (base64Key) => {
    if (typeof base64Key !== "string" || base64Key.length === 0) return "";
    let blob;
    try {
      blob = Buffer.from(base64Key, "base64");
    } catch {
      return "";
    }
    if (blob.length === 0) return "";
    return stripFingerprintPadding(
      crypto.createHash("sha256").update(blob).digest("base64"),
    );
  };

  // The canonical host token OpenSSH uses as the hashed/plain lookup key:
  // the bare host on the default port, `[host]:port` otherwise. Built for the
  // host exactly as supplied and (when different) its lowercase form, so a
  // case-insensitive hostname still matches a hashed entry hashed in either
  // case. Only ever broadens matching against the user's own trusted file.
  const buildLookupTokens = (hostname, port) => {
    const raw = String(hostname || "").trim();
    if (!raw) return [];
    const variants = new Set([raw]);
    const lower = raw.toLowerCase();
    variants.add(lower);
    const tokens = new Set();
    const usePort = Number.isFinite(port) && Number(port) !== 22;
    for (const variant of variants) {
      tokens.add(usePort ? `[${variant}]:${Number(port)}` : variant);
    }
    return [...tokens];
  };

  // Does a plain (non-hashed) host field cover (hostname, port)? Handles
  // comma-separated lists and `[host]:port`. Wildcards and negations are not
  // honored (see module header).
  const plainHostFieldMatches = (hostField, hostname, port) => {
    const wantHost = normalizeHostname(hostname);
    if (!wantHost) return false;
    const wantPort = Number.isFinite(port) ? Number(port) : 22;
    const patterns = String(hostField || "").split(",");
    for (const pattern of patterns) {
      const token = pattern.trim();
      if (!token) continue;
      // Skip negations and wildcard patterns — not a safe exact match.
      if (token.startsWith("!") || token.includes("*") || token.includes("?")) {
        continue;
      }
      const bracket = token.match(/^\[([^\]]+)\]:(\d+)$/);
      if (bracket) {
        if (
          normalizeHostname(bracket[1]) === wantHost &&
          Number.parseInt(bracket[2], 10) === wantPort
        ) {
          return true;
        }
        continue;
      }
      // A bare token implies the default SSH port.
      if (normalizeHostname(token) === wantHost && wantPort === 22) {
        return true;
      }
    }
    return false;
  };

  // Does a hashed host field (`|1|salt|hash`) cover (hostname, port)? Matches
  // by recomputing HMAC-SHA1(salt, token) for each canonical lookup token.
  const hashedHostFieldMatches = (hostField, hostname, port) => {
    const field = String(hostField || "");
    if (!field.startsWith(HASH_MARKER)) return false;
    const rest = field.slice(HASH_MARKER.length);
    const sep = rest.indexOf("|");
    if (sep <= 0) return false;
    const saltB64 = rest.slice(0, sep);
    const expected = rest.slice(sep + 1);
    if (!saltB64 || !expected) return false;

    let salt;
    try {
      salt = Buffer.from(saltB64, "base64");
    } catch {
      return false;
    }
    if (salt.length === 0) return false;

    let expectedBuf;
    try {
      expectedBuf = Buffer.from(expected, "base64");
    } catch {
      return false;
    }
    if (expectedBuf.length === 0) return false;

    // Use the host string exactly as supplied (and its lowercase form) when
    // building tokens — a hashed entry preserves the literal name OpenSSH saw.
    for (const token of buildLookupTokens(hostname, port)) {
      let computed;
      try {
        computed = crypto.createHmac("sha1", salt).update(token).digest();
      } catch {
        continue;
      }
      if (
        computed.length === expectedBuf.length &&
        crypto.timingSafeEqual(computed, expectedBuf)
      ) {
        return true;
      }
    }
    return false;
  };

  const hostFieldMatches = (hostField, hostname, port) => {
    if (String(hostField || "").startsWith(HASH_MARKER)) {
      return hashedHostFieldMatches(hostField, hostname, port);
    }
    return plainHostFieldMatches(hostField, hostname, port);
  };

  // Parse one known_hosts line into { revoked, certAuthority, hostField,
  // keyType, fingerprint } or null when it is a comment / blank / malformed.
  // The fingerprint is the SHA-256 of the line's key blob.
  const parseKnownHostsLine = (rawLine) => {
    const line = String(rawLine || "").trim();
    if (!line || line.startsWith("#")) return null;

    let rest = line;
    let revoked = false;
    let certAuthority = false;

    // Leading markers: `@revoked` / `@cert-authority` (one per line in
    // practice). Consume any leading `@…` token.
    while (rest.startsWith("@")) {
      const spaceIdx = rest.search(/\s/);
      if (spaceIdx < 0) return null;
      const marker = rest.slice(0, spaceIdx);
      if (marker === "@revoked") revoked = true;
      else if (marker === "@cert-authority") certAuthority = true;
      // Unknown markers are ignored but still consumed.
      rest = rest.slice(spaceIdx).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) return null;
    const [hostField, keyType, keyBlob] = parts;
    if (!hostField || !keyType || !keyBlob) return null;

    const fingerprint = fingerprintFromKeyBlob(keyBlob);
    if (!fingerprint) return null;

    return { revoked, certAuthority, hostField, keyType, fingerprint };
  };

  // The OpenSSH default trust files, mirroring localFsBridge.readKnownHosts so
  // the companion trusts exactly what the user's system ssh would.
  const getSystemKnownHostsPaths = () => {
    const homeDir = os.homedir();
    const paths = [path.join(homeDir, ".ssh", "known_hosts")];
    if (process.platform === "win32") {
      paths.push(
        path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ssh", "known_hosts"),
      );
    } else {
      paths.push("/etc/ssh/ssh_known_hosts");
    }
    return paths;
  };

  const readSystemKnownHostsContent = () => {
    let combined = "";
    for (const filePath of getSystemKnownHostsPaths()) {
      let content;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        // Missing / unreadable file is expected (e.g. no /etc/ssh on macOS).
        continue;
      }
      if (content && content.length > 0) {
        combined += combined ? `\n${content}` : content;
      }
    }
    return combined;
  };

  /**
   * Is the host key the server just presented already trusted by the user's
   * system OpenSSH known_hosts?
   *
   * Returns true ONLY when a non-revoked plain/hashed entry for (hostname,
   * port) records a key whose SHA-256 fingerprint equals `fingerprint`. A
   * `@revoked` entry that matches the fingerprint forces a hard `false` — a
   * revoked key must never be trusted, even if an older non-revoked entry also
   * lists it. Any read/parse error fails closed (returns false).
   *
   * @param {object} params
   * @param {string} params.hostname - SSH host the companion targets.
   * @param {number} [params.port=22] - SSH port.
   * @param {string} params.fingerprint - SHA-256 base64 (no padding, no
   *   `SHA256:` prefix) of the live host key.
   * @returns {boolean}
   */
  const isHostKeyTrustedBySystem = ({ hostname, port = 22, fingerprint } = {}) => {
    const wantFingerprint = stripFingerprintPadding(fingerprint);
    if (!hostname || !wantFingerprint) return false;

    let content;
    try {
      content = readSystemKnownHostsContent();
    } catch (err) {
      log?.(
        "[Mosh] failed to read system known_hosts:",
        err?.message || String(err),
      );
      return false;
    }
    if (!content) return false;

    let trusted = false;
    for (const rawLine of content.split(/\r?\n/)) {
      const entry = parseKnownHostsLine(rawLine);
      if (!entry) continue;
      // @cert-authority delegates to a CA rather than pinning a literal host
      // key; the fingerprint-equality model does not apply, so skip it.
      if (entry.certAuthority) continue;
      if (entry.fingerprint !== wantFingerprint) continue;
      if (!hostFieldMatches(entry.hostField, hostname, port)) continue;
      // A matching @revoked entry is an explicit "never trust this key" and
      // overrides any non-revoked match.
      if (entry.revoked) return false;
      trusted = true;
    }
    return trusted;
  };

  return {
    isHostKeyTrustedBySystem,
    readSystemKnownHostsContent,
    // Exposed for unit testing.
    parseKnownHostsLine,
    hostFieldMatches,
    plainHostFieldMatches,
    hashedHostFieldMatches,
    fingerprintFromKeyBlob,
    buildLookupTokens,
    getSystemKnownHostsPaths,
  };
}

module.exports = { createSystemKnownHostsApi };
