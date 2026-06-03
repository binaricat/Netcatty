const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");

const { createSystemKnownHostsApi } = require("./systemKnownHosts.cjs");

// Build an api whose fs.readFileSync returns the given content for the FIRST
// system known_hosts path and throws (ENOENT-like) for the rest, mirroring the
// common case of only `~/.ssh/known_hosts` existing.
function makeApi(fileContents = {}) {
  const reads = [];
  const fs = {
    readFileSync(filePath) {
      reads.push(filePath);
      if (Object.prototype.hasOwnProperty.call(fileContents, filePath)) {
        return fileContents[filePath];
      }
      const err = new Error(`ENOENT: ${filePath}`);
      err.code = "ENOENT";
      throw err;
    },
  };
  const logs = [];
  const api = createSystemKnownHostsApi({
    fs,
    path,
    os,
    crypto,
    log: (...args) => logs.push(args),
  });
  return { api, reads, logs };
}

// SHA-256 base64 (no padding) fingerprint of an OpenSSH public-key blob.
function fingerprintOf(base64Key) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(base64Key, "base64"))
    .digest("base64")
    .replace(/=+$/g, "");
}

// A valid-looking ed25519 key blob seeded deterministically.
function keyBlob(seed) {
  return (
    "AAAAC3NzaC1lZDI1NTE5AAAAI" +
    crypto.createHash("sha256").update(seed).digest("base64").slice(0, 27)
  );
}

// Produce a hashed host field `|1|salt|HMAC-SHA1(salt, token)` for `token`,
// exactly as `ssh-keygen -H` would (verified empirically against ssh-keygen).
function hashedHostField(token, salt = crypto.randomBytes(20)) {
  const hash = crypto.createHmac("sha1", salt).update(token).digest("base64");
  return `|1|${salt.toString("base64")}|${hash}`;
}

const HOME_KH = path.join(os.homedir(), ".ssh", "known_hosts");

test("system known_hosts paths include the OpenSSH defaults for the platform", () => {
  const { api } = makeApi();
  const paths = api.getSystemKnownHostsPaths();
  assert.ok(paths.includes(HOME_KH), "must include ~/.ssh/known_hosts");
  if (process.platform === "win32") {
    assert.ok(
      paths.some((p) => /ssh[\\/]known_hosts$/i.test(p) && /ProgramData/i.test(p)),
      "Windows must include %PROGRAMDATA%/ssh/known_hosts",
    );
  } else {
    assert.ok(paths.includes("/etc/ssh/ssh_known_hosts"));
  }
});

test("trusts a plain entry whose fingerprint matches (default port)", () => {
  const blob = keyBlob("plain");
  const { api } = makeApi({
    [HOME_KH]: `example.com ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      port: 22,
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("matches hostnames case-insensitively", () => {
  const blob = keyBlob("case");
  const { api } = makeApi({ [HOME_KH]: `Example.COM ssh-ed25519 ${blob}\n` });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("matches a comma-separated host list", () => {
  const blob = keyBlob("list");
  const { api } = makeApi({
    [HOME_KH]: `alias.example.com,192.0.2.5 ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "192.0.2.5",
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("matches a [host]:port entry only on the right non-default port", () => {
  const blob = keyBlob("port");
  const { api } = makeApi({
    [HOME_KH]: `[example.com]:2222 ssh-ed25519 ${blob}\n`,
  });
  const fingerprint = fingerprintOf(blob);
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", port: 2222, fingerprint }),
    true,
  );
  // Same host, wrong port -> not trusted.
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", port: 22, fingerprint }),
    false,
  );
});

test("does NOT trust a fingerprint mismatch (different key for the same host)", () => {
  const stored = keyBlob("stored");
  const live = keyBlob("live-different");
  const { api } = makeApi({ [HOME_KH]: `example.com ssh-ed25519 ${stored}\n` });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      fingerprint: fingerprintOf(live),
    }),
    false,
  );
});

test("does NOT trust when the host does not appear at all", () => {
  const blob = keyBlob("other");
  const { api } = makeApi({ [HOME_KH]: `other.example.com ssh-ed25519 ${blob}\n` });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      fingerprint: fingerprintOf(blob),
    }),
    false,
  );
});

test("trusts a hashed entry whose token + fingerprint match (default port)", () => {
  const blob = keyBlob("hashed-default");
  const { api } = makeApi({
    [HOME_KH]: `${hashedHostField("example.com")} ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      port: 22,
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("trusts a hashed entry for a non-default port ([host]:port token)", () => {
  const blob = keyBlob("hashed-port");
  const { api } = makeApi({
    [HOME_KH]: `${hashedHostField("[h.example.com]:2022")} ssh-ed25519 ${blob}\n`,
  });
  const fingerprint = fingerprintOf(blob);
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "h.example.com", port: 2022, fingerprint }),
    true,
  );
  // The same hashed entry must NOT match the default-port (bare-host) token.
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "h.example.com", port: 22, fingerprint }),
    false,
  );
});

test("hashed entry does not match a different hostname (HMAC differs)", () => {
  const blob = keyBlob("hashed-wrong-host");
  const { api } = makeApi({
    [HOME_KH]: `${hashedHostField("example.com")} ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "evil.example.com",
      fingerprint: fingerprintOf(blob),
    }),
    false,
  );
});

test("matches against ssh-keygen-generated hashed entries (real fixtures)", () => {
  // These two lines were produced by `ssh-keygen -H` from:
  //   example.com         ssh-ed25519 …KEYDATA0000…
  //   [example.com]:2222  ssh-ed25519 …KEYDATA1111…
  // and pin the exact HMAC-SHA1 hashing OpenSSH uses (incl. the bracketed
  // token for the non-default port).
  const blobA = "AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYDATA0000000000000000000000000";
  const blobB = "AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYDATA1111111111111111111111111";
  const content =
    `|1|GjfxyrxES8V34vZje/1Lt1hHg/Y=|ZEnB8OFqAbq3mcme43V+dukJ51I= ssh-ed25519 ${blobA}\n` +
    `|1|uZT6RsKBJirh9q9ycDnQUhVSmqI=|auufYDNOuFA17oSrmJwneIyl9po= ssh-ed25519 ${blobB}\n`;
  const { api } = makeApi({ [HOME_KH]: content });

  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      port: 22,
      fingerprint: fingerprintOf(blobA),
    }),
    true,
    "default-port hashed entry must match",
  );
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      port: 2222,
      fingerprint: fingerprintOf(blobB),
    }),
    true,
    "non-default-port hashed entry must match",
  );
  // The 2222 key must NOT be accepted for port 22 (token differs).
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      port: 22,
      fingerprint: fingerprintOf(blobB),
    }),
    false,
  );
});

test("a @revoked entry with a matching fingerprint forces NOT trusted", () => {
  const blob = keyBlob("revoked");
  const fingerprint = fingerprintOf(blob);
  // Even if a non-revoked entry would also match, the revoked one wins.
  const content =
    `example.com ssh-ed25519 ${blob}\n` +
    `@revoked example.com ssh-ed25519 ${blob}\n`;
  const { api } = makeApi({ [HOME_KH]: content });
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", fingerprint }),
    false,
  );
});

test("a @revoked hashed entry also forces NOT trusted", () => {
  const blob = keyBlob("revoked-hashed");
  const fingerprint = fingerprintOf(blob);
  const content = `@revoked ${hashedHostField("example.com")} ssh-ed25519 ${blob}\n`;
  const { api } = makeApi({ [HOME_KH]: content });
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", fingerprint }),
    false,
  );
});

test("a @cert-authority line is skipped (not a literal host-key match)", () => {
  const blob = keyBlob("ca");
  const { api } = makeApi({
    [HOME_KH]: `@cert-authority *.example.com ssh-ed25519 ${blob}\n`,
  });
  // Fingerprint matches the CA key, but CA delegation is not modeled -> not
  // trusted via this path.
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "host.example.com",
      fingerprint: fingerprintOf(blob),
    }),
    false,
  );
});

test("comments, blank lines, and malformed lines are ignored", () => {
  const blob = keyBlob("with-comments");
  const content = [
    "# a comment",
    "",
    "   ",
    "garbage-without-enough-fields",
    `example.com ssh-ed25519 ${blob}`,
    "# trailing comment",
  ].join("\n");
  const { api } = makeApi({ [HOME_KH]: content });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("wildcard / negation host patterns are not honored for trust", () => {
  const blob = keyBlob("wild");
  const fingerprint = fingerprintOf(blob);
  const wildcard = makeApi({ [HOME_KH]: `*.example.com ssh-ed25519 ${blob}\n` });
  assert.equal(
    wildcard.api.isHostKeyTrustedBySystem({ hostname: "host.example.com", fingerprint }),
    false,
    "a wildcard entry must not vouch for a specific host's key we never saw",
  );
  const negated = makeApi({
    [HOME_KH]: `!example.com,example.com ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    negated.api.isHostKeyTrustedBySystem({ hostname: "example.com", fingerprint }),
    true,
    "the non-negated token in the list still matches",
  );
});

test("combines multiple system files (home + /etc) into the trust set", () => {
  const blob = keyBlob("etc");
  const etcPath = process.platform === "win32"
    ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ssh", "known_hosts")
    : "/etc/ssh/ssh_known_hosts";
  const { api } = makeApi({
    [HOME_KH]: "# only comments here\n",
    [etcPath]: `shared.example.com ssh-ed25519 ${blob}\n`,
  });
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "shared.example.com",
      fingerprint: fingerprintOf(blob),
    }),
    true,
  );
});

test("returns false (fail-closed) when no system files exist", () => {
  const { api, reads } = makeApi(); // every read throws ENOENT
  assert.equal(
    api.isHostKeyTrustedBySystem({
      hostname: "example.com",
      fingerprint: "anything",
    }),
    false,
  );
  assert.ok(reads.length >= 1, "should have attempted to read at least one path");
});

test("returns false on empty/whitespace fingerprint or hostname", () => {
  const blob = keyBlob("guard");
  const { api } = makeApi({ [HOME_KH]: `example.com ssh-ed25519 ${blob}\n` });
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "", fingerprint: fingerprintOf(blob) }),
    false,
  );
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", fingerprint: "" }),
    false,
  );
  assert.equal(api.isHostKeyTrustedBySystem({}), false);
});

test("fingerprint comparison ignores base64 padding differences", () => {
  const blob = keyBlob("padding");
  const { api } = makeApi({ [HOME_KH]: `example.com ssh-ed25519 ${blob}\n` });
  const padded = `${fingerprintOf(blob)}==`;
  assert.equal(
    api.isHostKeyTrustedBySystem({ hostname: "example.com", fingerprint: padded }),
    true,
  );
});

test("parseKnownHostsLine extracts markers and fingerprint", () => {
  const blob = keyBlob("parse-line");
  const { api } = makeApi();
  const entry = api.parseKnownHostsLine(`@revoked example.com ssh-rsa ${blob}`);
  assert.equal(entry.revoked, true);
  assert.equal(entry.certAuthority, false);
  assert.equal(entry.hostField, "example.com");
  assert.equal(entry.keyType, "ssh-rsa");
  assert.equal(entry.fingerprint, fingerprintOf(blob));
  assert.equal(api.parseKnownHostsLine("# comment"), null);
  assert.equal(api.parseKnownHostsLine(""), null);
  assert.equal(api.parseKnownHostsLine("too few"), null);
});
