const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  classifyHostKey,
  createHostVerifier,
  describeHostKey,
  handleResponse,
  normalizeFingerprint,
} = require("./hostKeyVerifier.cjs");

const makeRawPublicKey = (keyType, body = "trusted imported host key") => {
  const type = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  return Buffer.concat([length, type, Buffer.from(body)]);
};

test("classifyHostKey prompts for unknown hosts", () => {
  const result = classifyHostKey({
    knownHosts: [],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "unknown");
});

test("classifyHostKey trusts a matching known host fingerprint", () => {
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:trusted-key",
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "trusted-key",
  });

  assert.equal(result.status, "trusted");
});

test("classifyHostKey trusts a matching full known_hosts public key", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const fingerprint = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint,
  });

  assert.equal(result.status, "trusted");
});

test("describeHostKey preserves the full public key from raw SSH key blobs", () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const result = describeHostKey(rawKey);

  assert.equal(result.keyType, "ssh-ed25519");
  assert.equal(result.publicKey, `ssh-ed25519 ${rawKey.toString("base64")}`);
});

test("classifyHostKey warns when a known host fingerprint changes", () => {
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "192.0.2.10",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:old-key",
      discoveredAt: 1,
    }],
    hostname: "192.0.2.10",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "changed");
  assert.equal(result.knownHost?.id, "kh-1");
  assert.equal(result.expectedFingerprint, "old-key");
});

test("classifyHostKey treats the same hostname on a different port as unknown", () => {
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 2222,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:trusted-key",
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "trusted-key",
  });

  assert.equal(result.status, "unknown");
});

test("classifyHostKey reports unknown when only the incoming key type is unknown", () => {
  // Without a confident key type from ssh2 we cannot tell whether this is a
  // rotation of the stored key or a brand-new algorithm; force the user back
  // through the first-time-trust path rather than scaring them with a
  // "fingerprint changed" warning (#972).
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:trusted-key",
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "unknown",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "unknown");
});

test("classifyHostKey reports unknown when the stored record has no key type", () => {
  // Legacy / imported records sometimes have an empty or "unknown" keyType.
  // Promoting those to "changed" on every connect was the root cause of #972;
  // treat them as not-comparable so the user re-confirms cleanly.
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "unknown",
      publicKey: "SHA256:trusted-key",
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "unknown");
});

test("classifyHostKey reports unknown when the server presents a different key type than any stored record", () => {
  // Server with ssh-rsa stored; presents ssh-ed25519 this time. OpenSSH treats
  // this as a new key offering, not a rotation; we match that behavior so a
  // host with multiple algorithms doesn't spam mismatch warnings on every
  // algorithm renegotiation.
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-rsa",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-rsa",
      publicKey: "SHA256:rsa-key",
      discoveredAt: 1,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "unknown");
});

test("classifyHostKey prefers exact key type mismatches when a host has multiple keys", () => {
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-rsa",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-rsa",
      publicKey: "SHA256:rsa-key",
      discoveredAt: 1,
    }, {
      id: "kh-ed25519",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:ed25519-key",
      discoveredAt: 2,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "changed");
  assert.equal(result.knownHost?.id, "kh-ed25519");
});

test("classifyHostKey does not pick an arbitrary known host when incoming key type is unknown", () => {
  const result = classifyHostKey({
    knownHosts: [{
      id: "kh-rsa",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-rsa",
      publicKey: "SHA256:rsa-key",
      discoveredAt: 1,
    }, {
      id: "kh-ed25519",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:ed25519-key",
      discoveredAt: 2,
    }],
    hostname: "switch.local",
    port: 22,
    keyType: "unknown",
    fingerprint: "new-key",
  });

  assert.equal(result.status, "unknown");
});

test("normalizeFingerprint accepts SHA256-prefixed values", () => {
  assert.equal(normalizeFingerprint("SHA256:abc123==="), "abc123");
});

test("createHostVerifier accepts trusted host keys without prompting", async () => {
  const rawKey = Buffer.from("trusted server key");
  const fingerprint = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/g, "");
  const sent = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const verifier = createHostVerifier({
    sender,
    sessionId: "session-1",
    hostname: "switch.local",
    port: 22,
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "unknown",
      publicKey: `SHA256:${fingerprint}`,
      discoveredAt: 1,
    }],
  });

  const accepted = await new Promise((resolve) => verifier(rawKey, resolve));

  assert.equal(accepted, true);
  assert.deepEqual(sent, []);
});

test("createHostVerifier accepts imported full known_hosts public keys without prompting", async () => {
  const rawKey = makeRawPublicKey("ssh-ed25519");
  const sent = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const verifier = createHostVerifier({
    sender,
    sessionId: "session-1",
    hostname: "switch.local",
    port: 22,
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: `ssh-ed25519 ${rawKey.toString("base64")}`,
      discoveredAt: 1,
    }],
  });

  const accepted = await new Promise((resolve) => verifier(rawKey, resolve));

  assert.equal(accepted, true);
  assert.deepEqual(sent, []);
});

test("createHostVerifier prompts for unknown host keys and waits for user response", async () => {
  const rawKey = Buffer.from("new server key");
  const sent = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const verifier = createHostVerifier({
    sender,
    sessionId: "session-1",
    hostname: "switch.local",
    port: 22,
    knownHosts: [],
  });

  const acceptedPromise = new Promise((resolve) => verifier(rawKey, resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:host-key:verify");
  assert.equal(sent[0].payload.hostname, "switch.local");
  assert.equal(sent[0].payload.status, "unknown");

  handleResponse(null, {
    requestId: sent[0].payload.requestId,
    accept: true,
    addToKnownHosts: true,
  });

  assert.equal(await acceptedPromise, true);
});

test("createHostVerifier includes existing known host details when a key changes", async () => {
  // A well-formed wire blob so `describeHostKey` can recover keyType =
  // "ssh-ed25519"; that triggers the strict (host, port, type) mismatch
  // branch with a stored record of the same type but different fingerprint.
  const rawKey = makeRawPublicKey("ssh-ed25519", "changed server key");
  const sent = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const verifier = createHostVerifier({
    sender,
    sessionId: "session-1",
    hostname: "switch.local",
    port: 22,
    knownHosts: [{
      id: "kh-1",
      hostname: "switch.local",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "SHA256:old-key",
      fingerprint: "old-key",
      discoveredAt: 1,
    }],
  });

  const acceptedPromise = new Promise((resolve) => verifier(rawKey, resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:host-key:verify");
  assert.equal(sent[0].payload.status, "changed");
  assert.equal(sent[0].payload.knownHostId, "kh-1");
  assert.equal(sent[0].payload.knownFingerprint, "old-key");

  handleResponse(null, {
    requestId: sent[0].payload.requestId,
    accept: true,
    addToKnownHosts: true,
  });

  assert.equal(await acceptedPromise, true);
});
