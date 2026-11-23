"use strict";

// --- merged from sshAuthHelper.passwordOnly.test.cjs ---
{
/**
 * Password-only auth must not probe default ~/.ssh keys (issues #266 / #2079).
 * Jump hosts and SFTP share buildAuthHandler; a wrong host password used to
 * look fine on direct terminal (startSession still fell back to id_rsa) while
 * ProxyJump / SFTP failed after password rejection alone.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAuthHandler } = require("./sshAuthHelper.cjs");

const DEFAULT_KEYS = [
  {
    keyName: "id_ed25519",
    keyPath: "/tmp/id_ed25519",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ned\n-----END OPENSSH PRIVATE KEY-----\n",
  },
  {
    keyName: "id_rsa",
    keyPath: "/tmp/id_rsa",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nrsa\n-----END RSA PRIVATE KEY-----\n",
  },
];

/**
 * Walk the ssh2-style authHandler and collect method labels.
 * Object methods expose type (and sometimes username/key); string methods
 * come from the simple ordered-list path (e.g. password-only).
 */
function collectAuthMethods(authHandler, maxSteps = 16) {
  const labels = [];
  let methodsLeft = null;
  for (let i = 0; i < maxSteps; i += 1) {
    let offered = null;
    authHandler(methodsLeft, false, (method) => {
      offered = method;
    });
    if (offered == null || offered === false) break;
    if (typeof offered === "string") {
      labels.push(offered);
    } else if (offered && typeof offered === "object") {
      labels.push(offered.type || "unknown");
    } else {
      break;
    }
    // Keep all common methods available so the handler can walk its full list.
    methodsLeft = ["publickey", "password", "keyboard-interactive", "agent"];
  }
  return labels;
}

test("buildAuthHandler password-only does not offer default SSH keys (#2079)", () => {
  const auth = buildAuthHandler({
    password: "wrong-or-stale-secret",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("password"), `expected password; got ${labels.join(",")}`);
  assert.ok(labels.includes("keyboard-interactive"), `expected KI; got ${labels.join(",")}`);
  assert.equal(
    labels.includes("publickey"),
    false,
    `password-only must not probe default keys; offered=${labels.join(",")}`,
  );
  assert.equal(labels.includes("agent"), false);
});

test("buildAuthHandler password-only still fires onAuthAttempt for jump/SFTP progress", () => {
  const attempts = [];
  const auth = buildAuthHandler({
    password: "secret",
    username: "root",
    // Default keys on disk used to force the dynamic path for progress only;
    // after #2079 the simple ordered path must still report attempts.
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
    onAuthAttempt: (label) => attempts.push(label),
  });

  collectAuthMethods(auth.authHandler);
  assert.ok(
    attempts.some((label) => label === "password" || label.includes("password")),
    `expected password attempt callback; got ${attempts.join(" | ")}`,
  );
  assert.ok(
    attempts.some((label) => label.includes("keyboard-interactive") || label.includes("exhausted")),
    `expected KI or exhaustion callback; got ${attempts.join(" | ")}`,
  );
  assert.equal(
    attempts.some((label) => /id_rsa|id_ed25519|default/.test(label)),
    false,
    `must not report default-key probes; got ${attempts.join(" | ")}`,
  );
});

test("buildAuthHandler automatic mode tries agent and default keys before password", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    password: "saved-secret",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    sshAgentSocketOverride: "/tmp/ssh-agent.sock",
  });

  const labels = collectAuthMethods(auth.authHandler);
  const agentIndex = labels.indexOf("agent");
  const keyIndex = labels.indexOf("publickey");
  const passwordIndex = labels.indexOf("password");
  assert.ok(agentIndex >= 0, `expected agent; got ${labels.join(",")}`);
  assert.ok(keyIndex >= 0, `expected publickey; got ${labels.join(",")}`);
  assert.ok(passwordIndex >= 0, `expected password; got ${labels.join(",")}`);
  assert.ok(agentIndex < passwordIndex, `agent should precede password; got ${labels.join(",")}`);
  assert.ok(keyIndex < passwordIndex, `default key should precede password; got ${labels.join(",")}`);
  assert.ok(
    labels.every((label, index) => label !== "publickey" || index < passwordIndex),
    `all default keys should precede password; got ${labels.join(",")}`,
  );
});

test("buildAuthHandler automatic mode skips an unavailable validated agent", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    password: "saved-secret",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    sshAgentSocketOverride: null,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.equal(labels.includes("agent"), false, labels.join(","));
  assert.equal(labels.includes("publickey"), true, labels.join(","));
  assert.equal(labels.includes("password"), true, labels.join(","));
});

test("buildAuthHandler with no credentials still offers default keys", () => {
  const auth = buildAuthHandler({
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(
    labels.includes("publickey"),
    `expected default-key fallback when no explicit auth; offered=${labels.join(",")}`,
  );
});

test("buildAuthHandler key+password still allows default key fallback after user key", () => {
  const auth = buildAuthHandler({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nuser\n-----END OPENSSH PRIVATE KEY-----\n",
    password: "also-have-password",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("publickey"), `expected publickey; offered=${labels.join(",")}`);
  assert.ok(labels.includes("password"), `expected password; offered=${labels.join(",")}`);
  // user key + at least one default key => multiple publickey offers
  const publickeyCount = labels.filter((l) => l === "publickey").length;
  assert.ok(
    publickeyCount >= 2,
    `key auth may still fall back to default keys; offered=${labels.join(",")}`,
  );
});

test("buildAuthHandler explicit key mode uses only the selected key and stated password fallback", () => {
  const auth = buildAuthHandler({
    authMethod: "key",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nuser\n-----END OPENSSH PRIVATE KEY-----\n",
    password: "fallback-password",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: true,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.equal(labels.filter((label) => label === "publickey").length, 1, labels.join(","));
  assert.equal(labels.includes("agent"), false, labels.join(","));
  assert.equal(labels.includes("password"), true, labels.join(","));
});

test("buildAuthHandler explicit key mode never substitutes an unrelated default key", () => {
  const auth = buildAuthHandler({
    authMethod: "key",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: true,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.equal(labels.includes("publickey"), false, labels.join(","));
  assert.equal(labels.includes("agent"), false, labels.join(","));
  assert.equal(auth.privateKey, null);
});

test("buildAuthHandler explicit password mode ignores an agent and default keys", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    password: "host-password",
    agent: "/tmp/agent.sock",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: true,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.equal(labels.includes("agent"), false, labels.join(","));
  assert.equal(labels.includes("publickey"), false, labels.join(","));
  assert.equal(labels.includes("password"), true, labels.join(","));
});

test("buildAuthHandler explicit password mode never submits an empty saved password", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    password: undefined,
    agent: "/tmp/agent.sock",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: true,
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.equal(labels.includes("password"), false, labels.join(","));
  assert.equal(labels.includes("agent"), false, labels.join(","));
  assert.equal(labels.includes("publickey"), false, labels.join(","));
  assert.equal(labels.includes("keyboard-interactive"), true, labels.join(","));
});

for (const authMethod of ["password", "key", "certificate"]) {
  test(`buildAuthHandler explicit ${authMethod} mode ignores unlocked default keys`, () => {
    const auth = buildAuthHandler({
      authMethod,
      password: "fallback-password",
      privateKey: authMethod === "password" ? undefined : "-----BEGIN OPENSSH PRIVATE KEY-----\nselected\n-----END OPENSSH PRIVATE KEY-----\n",
      username: "root",
      allowAgentFallback: false,
      unlockedEncryptedKeys: [{
        keyName: "id_unrelated",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nunrelated\n-----END OPENSSH PRIVATE KEY-----\n",
        passphrase: "key-pass",
      }],
    });

    const labels = collectAuthMethods(auth.authHandler);
    assert.equal(
      labels.filter((label) => label === "publickey").length,
      authMethod === "password" ? 0 : 1,
      labels.join(","),
    );
  });
}

test("buildAuthHandler password-only may still attach unlocked encrypted keys for jump retry", () => {
  const auth = buildAuthHandler({
    password: "host-password",
    username: "root",
    defaultKeys: DEFAULT_KEYS,
    allowAgentFallback: false,
    unlockedEncryptedKeys: [{
      keyName: "id_encrypted",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nenc\n-----END OPENSSH PRIVATE KEY-----\n",
      passphrase: "key-pass",
    }],
  });

  const labels = collectAuthMethods(auth.authHandler);
  assert.ok(labels.includes("password"), `offered=${labels.join(",")}`);
  assert.ok(
    labels.includes("publickey"),
    `jump-chain retry may still offer unlocked keys; offered=${labels.join(",")}`,
  );
});
}

// --- merged from sshAuthHelper.totp.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");

const { createKeyboardInteractiveHandler } = require("./sshAuthHelper.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { encodeBase32, generateTotp } = require("../../domain/totp.shared.cjs");

const SECRET = Buffer.from("12345678901234567890", "ascii");
const TOTP = {
  uri: `otpauth://totp/JumpServer:root?secret=${encodeBase32(SECRET)}&digits=8&period=30`,
  autoSubmit: true,
};

const createSender = () => {
  const sent = [];
  return {
    sent,
    sender: {
      id: 7,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
};

const drainPendingRequests = (sent, senderId = 7) => {
  for (const event of sent) {
    if (event.channel !== "netcatty:keyboard-interactive") continue;
    const requestId = event.payload?.requestId;
    if (requestId) {
      keyboardInteractiveHandler.handleResponse({ sender: { id: senderId } }, { requestId, cancelled: true });
    }
  }
};

const invoke = (handler, prompt, instructions = "") => {
  let finished = null;
  handler("root", instructions, "", [{ prompt, echo: true }], (responses) => {
    finished = responses;
  });
  return finished;
};

test("TOTP auto-submit runs once per connection attempt, then falls back to the dialog", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });
  const expected = generateTotp({
    secret: SECRET,
    algorithm: "SHA1",
    digits: 8,
    period: 30,
    timestamp: 15_000,
  });

  assert.deepEqual(invoke(handler, "[OTP Code]: ", "Please Enter MFA Code."), [expected]);
  assert.equal(sent.length, 0);

  const retry = invoke(handler, "[OTP Code]: ", "Please Enter MFA Code.");
  assert.equal(retry, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  assert.equal(sent[0].payload.totpUri, TOTP.uri);
  drainPendingRequests(sent);
});

test("keyboard-interactive dialog omits an encrypted TOTP placeholder", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-enc",
    hostname: "jumpserver.example",
    totp: { uri: "enc:v1:placeholder" },
    now: () => 15_000,
  });
  assert.equal(invoke(handler, "[OTP Code]: "), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.totpUri, undefined);
  drainPendingRequests(sent);
});

test("a non-matching prompt does not consume the one TOTP auto-submit", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-2",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });

  assert.equal(invoke(handler, "\n1. OTP\n2. SMS\nOption> ", "Please Select MFA Option"), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.totpUri, TOTP.uri);
  drainPendingRequests(sent);

  const code = invoke(handler, "[OTP Code]: ", "Please Enter MFA Code.");
  assert.equal(code?.[0]?.length, 8);
  assert.equal(sent.length, 1);
});

test("SMS, email, and confirmation prompts are never auto-answered", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-3",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });
  for (const prompt of ["[SMS Code]: ", "[EMAIL Code]: ", "Do you want to continue [Y/n]? : "]) {
    assert.equal(invoke(handler, prompt), null);
  }
  assert.equal(sent.length, 3);
  drainPendingRequests(sent);
});

test("legacy JumpServer and PAM prompts auto-submit, and a later mismatch opens the dialog", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-4",
    hostname: "pam.example",
    totp: TOTP,
    now: () => 15_000,
  });
  assert.equal(invoke(handler, "[MFA auth]: ")?.[0]?.length, 8);
  const fresh = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-5",
    hostname: "pam.example",
    totp: { ...TOTP },
    now: () => 15_000,
  });
  assert.equal(invoke(fresh, "Verification code: ")?.[0]?.length, 8);
  assert.equal(invoke(fresh, "Password:"), null);
  assert.equal(sent.length, 1);
  drainPendingRequests(sent);
});
}
