const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { mintHostCertificates, legacyCertificate, sshString, sshKeygenSkip } = require("./fixtures/hostCertificates.test.fixture.cjs");

const {
  classifyHostKey,
  createHostVerifier,
  describeHostKey,
  getKnownHostFingerprint,
  handleResponse,
  normalizeFingerprint,
} = require("./hostKeyVerifier.cjs");

const makeRawPublicKey = (keyType, body = "trusted imported host key") => {
  const type = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length, 0);
  return Buffer.concat([length, type, Buffer.from(body)]);
};

const hashKey = (blob) => crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/g, "");

test("host certificate renewals trust the inner key, including legacy saved fingerprints", { skip: sshKeygenSkip }, (t) => {
  const { first, renewed, different } = mintHostCertificates(t);
  const original = describeHostKey(first.blob);
  const live = describeHostKey(renewed.blob);
  const changed = describeHostKey(different.blob);
  assert.notDeepEqual(first.blob, renewed.blob);
  assert.equal(original.fingerprint, first.publicKeyFingerprint);
  assert.equal(live.fingerprint, original.fingerprint);
  assert.notEqual(changed.fingerprint, live.fingerprint);
  assert.equal(original.keyType, "ssh-ed25519-cert-v01@openssh.com");
  assert.equal(original.publicKey, `${first.keyType} ${first.blob.toString("base64")}`);
  assert.equal(describeHostKey(first.plain.blob).fingerprint, hashKey(first.plain.blob));

  const stored = { id: "kh-cert", hostname: "cert.local", port: 2222, ...original };
  const classify = (key, record = stored) => classifyHostKey({
    knownHosts: [record], hostname: "cert.local", port: 2222, ...key,
  });
  assert.equal(classify(live).status, "trusted");
  assert.equal(classify(changed).status, "changed");
  assert.equal(classify(changed, { ...stored, keyType: "ssh-rsa" }).status, "unknown");

  const legacy = { ...stored, fingerprint: hashKey(first.blob) };
  assert.notEqual(legacy.fingerprint, live.fingerprint);
  assert.equal(getKnownHostFingerprint(legacy), live.fingerprint);
  assert.equal(classify(live, legacy).status, "trusted");
  assert.equal(classify(changed, legacy).status, "changed");
  assert.equal(classify(live, { ...legacy, publicKey: undefined }).status, "changed");
  assert.equal(classify(live, { ...legacy, publicKey: `SHA256:${legacy.fingerprint}` }).status, "changed");
  assert.equal(classify(live, { ...legacy, fingerprint: "unrelated-explicit-fingerprint" }).status, "changed");
  assert.equal(classify(live, { ...legacy, fingerprint: undefined }).status, "trusted");

  // Renewal is trusted on reconnect, but changing the raw certificate during
  // an established connection must still be rejected synchronously on rekey.
  const verifier = createHostVerifier({ hostname: stored.hostname, port: stored.port, knownHosts: [legacy] });
  const results = [];
  verifier(first.blob, (accepted) => results.push(accepted));
  verifier(Buffer.from(first.blob), (accepted) => results.push(accepted));
  verifier(renewed.blob, (accepted) => results.push(accepted));
  assert.deepEqual(results, [true, true, false]);
});

for (const options of [
  { type: "rsa", bits: 2048 },
  ...[256, 384, 521].map((bits) => ({ type: "ecdsa", bits })),
  { type: "ed25519", sk: true },
  { type: "ecdsa", bits: 256, sk: true },
  { type: "ed25519", user: true },
]) {
  test(`certificate fingerprint matches ssh-keygen for ${JSON.stringify(options)}`, { skip: sshKeygenSkip }, (t) => {
    const { first, renewed, different } = mintHostCertificates(t, options);
    assert.equal(describeHostKey(first.blob).fingerprint, first.publicKeyFingerprint);
    assert.equal(describeHostKey(first.blob).fingerprint, hashKey(first.plain.blob));
    assert.equal(describeHostKey(renewed.blob).fingerprint, first.publicKeyFingerprint);
    assert.notEqual(describeHostKey(different.blob).fingerprint, first.publicKeyFingerprint);
  });
}

test("v00 certificates extract the key before the nonce", () => {
  for (const [type, fields] of [["ssh-rsa", ["exponent", "modulus"]], ["ssh-dss", ["p", "q", "g", "y"]]]) {
    const cert = legacyCertificate(type, fields);
    assert.equal(describeHostKey(cert.blob).fingerprint, hashKey(cert.plain));
    assert.equal(describeHostKey(cert.blob).keyType, `${type}-cert-v00@openssh.com`);
  }
});

test("malformed and unsupported certificates keep their full-blob fingerprint", () => {
  const truncated = Buffer.concat([
    sshString("ssh-ed25519-cert-v01@openssh.com"), sshString("nonce"), sshString(Buffer.alloc(32)),
  ]);
  const badLength = Buffer.concat([sshString("ssh-ed25519-cert-v01@openssh.com"), Buffer.from([255, 255, 255, 255])]);
  const unsupported = Buffer.concat([sshString("unknown-cert-v01@openssh.com"), sshString("nonce")]);
  for (const blob of [truncated, badLength, unsupported]) {
    assert.equal(describeHostKey(blob).fingerprint, hashKey(blob));
  }
});

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

test("createHostVerifier skips prompts when host key verification is disabled", async () => {
  const rawKey = Buffer.from("untrusted server key");
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
    verifyHostKeys: false,
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

  handleResponse({ sender: { id: sender.id } }, {
    requestId: sent[0].payload.requestId,
    accept: true,
    addToKnownHosts: true,
  });

  assert.equal(await acceptedPromise, true);
});

test("createHostVerifier answers rekeys synchronously with the key accepted at connect", async () => {
  const rawKey = Buffer.from("new server key");
  const sent = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  // The knownHosts snapshot stays empty for the life of the connection, as it
  // does when the user picks "Continue" or "Add and continue" on first connect.
  const verifier = createHostVerifier({
    sender,
    sessionId: "session-1",
    hostname: "switch.local",
    port: 22,
    knownHosts: [],
  });

  const acceptedPromise = new Promise((resolve) => verifier(rawKey, resolve));
  assert.equal(sent.length, 1);
  handleResponse({ sender: { id: sender.id } }, {
    requestId: sent[0].payload.requestId,
    accept: true,
    addToKnownHosts: false,
  });
  assert.equal(await acceptedPromise, true);

  // ssh2 re-runs the verifier on every rekey. It must answer before returning
  // (ssh2 keeps sending channel data while an async answer is pending) and
  // must not show the host-key dialog again.
  const rekeyResults = [];
  verifier(Buffer.from(rawKey), (ok) => rekeyResults.push(ok));
  assert.deepEqual(rekeyResults, [true]);
  assert.equal(sent.length, 1);
});

test("createHostVerifier rejects a different host key on rekey without prompting", async () => {
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

  assert.equal(await new Promise((resolve) => verifier(rawKey, resolve)), true);

  const rekeyResults = [];
  verifier(Buffer.from("other server key"), (ok) => rekeyResults.push(ok));
  assert.deepEqual(rekeyResults, [false]);
  assert.deepEqual(sent, []);
});

test("createHostVerifier still prompts on the next connect after a rejected key", async () => {
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

  const first = new Promise((resolve) => verifier(rawKey, resolve));
  handleResponse({ sender: { id: sender.id } }, { requestId: sent[0].payload.requestId, accept: false });
  assert.equal(await first, false);

  const second = new Promise((resolve) => verifier(rawKey, resolve));
  assert.equal(sent.length, 2);
  handleResponse({ sender: { id: sender.id } }, { requestId: sent[1].payload.requestId, accept: true });
  assert.equal(await second, true);
});

test("createHostVerifier forwards bootEpoch on host-key prompts", async () => {
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
    bootEpoch: 7,
  });

  const acceptedPromise = new Promise((resolve) => verifier(rawKey, resolve));
  assert.equal(sent[0].payload.bootEpoch, 7);

  handleResponse({ sender: { id: sender.id } }, {
    requestId: sent[0].payload.requestId,
    accept: false,
  });
  assert.equal(await acceptedPromise, false);
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

  handleResponse({ sender: { id: sender.id } }, {
    requestId: sent[0].payload.requestId,
    accept: true,
    addToKnownHosts: true,
  });

  assert.equal(await acceptedPromise, true);
});
