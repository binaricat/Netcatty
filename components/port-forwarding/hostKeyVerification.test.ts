import test from "node:test";
import assert from "node:assert/strict";

import {
  createKnownHostFromPortForwardHostKeyInfo,
  enqueuePortForwardHostKeyVerification,
  isPortForwardHostKeySessionId,
  removePortForwardHostKeyVerification,
  toPendingPortForwardHostKeyVerification,
} from "./hostKeyVerification.ts";

test("isPortForwardHostKeySessionId only accepts port-forward tunnel sessions", () => {
  assert.equal(isPortForwardHostKeySessionId("pf-rule-1-123456"), true);
  assert.equal(isPortForwardHostKeySessionId("session-1"), false);
  assert.equal(isPortForwardHostKeySessionId(undefined), false);
});

test("createKnownHostFromPortForwardHostKeyInfo saves the verified host key", () => {
  assert.deepEqual(
    createKnownHostFromPortForwardHostKeyInfo(
      {
        hostname: "jump.internal",
        port: 2200,
        keyType: "ssh-ed25519",
        fingerprint: "abc123",
        publicKey: "ssh-ed25519 AAAA",
      },
      1000,
      "fixed",
    ),
    {
      id: "kh-1000-fixed",
      hostname: "jump.internal",
      port: 2200,
      keyType: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAA",
      fingerprint: "abc123",
      discoveredAt: 1000,
    },
  );
});

test("toPendingPortForwardHostKeyVerification ignores non-port-forward requests", () => {
  assert.equal(
    toPendingPortForwardHostKeyVerification({
      requestId: "req-terminal",
      sessionId: "terminal-session",
      hostname: "terminal.example.com",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "terminal-fingerprint",
    }),
    null,
  );
});

test("toPendingPortForwardHostKeyVerification accepts port-forward requests", () => {
  assert.deepEqual(
    toPendingPortForwardHostKeyVerification({
      requestId: "req-port-forward",
      sessionId: "pf-rule-1-123456",
      hostname: "jump.internal",
      port: 2200,
      keyType: "ssh-ed25519",
      fingerprint: "abc123",
      publicKey: "ssh-ed25519 AAAA",
      status: "unknown",
    }),
    {
      requestId: "req-port-forward",
      hostKeyInfo: {
        hostname: "jump.internal",
        port: 2200,
        keyType: "ssh-ed25519",
        fingerprint: "abc123",
        publicKey: "ssh-ed25519 AAAA",
        status: "unknown",
        knownHostId: undefined,
        knownFingerprint: undefined,
      },
    },
  );
});

test("port-forward host-key confirmations are queued instead of overwritten", () => {
  const first = {
    requestId: "req-1",
    hostKeyInfo: {
      hostname: "jump-1.internal",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "first",
    },
  };
  const second = {
    requestId: "req-2",
    hostKeyInfo: {
      hostname: "jump-2.internal",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "second",
    },
  };

  const queued = enqueuePortForwardHostKeyVerification(
    enqueuePortForwardHostKeyVerification([], first),
    second,
  );

  assert.deepEqual(queued.map((pending) => pending.requestId), ["req-1", "req-2"]);
  assert.deepEqual(
    removePortForwardHostKeyVerification(queued, "req-1").map((pending) => pending.requestId),
    ["req-2"],
  );
});
