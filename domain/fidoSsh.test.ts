import test from "node:test";
import assert from "node:assert/strict";

import {
  SK_ECDSA_NISTP256,
  SK_SSH_ED25519,
  decodeOpenSshPrivateKeyBody,
  detectFidoSshKeyType,
  extractOpenSshPublicKeyType,
  isSkPrivateKey,
  isSkPublicKey,
  requiresFidoSshAgentAuth,
} from "./fidoSsh.ts";

const skEdPub =
  "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= user@fido";

const skEcdsaPub =
  "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= user@fido";

test("extractOpenSshPublicKeyType recognizes sk algorithms", () => {
  assert.equal(extractOpenSshPublicKeyType(skEdPub), SK_SSH_ED25519);
  assert.equal(extractOpenSshPublicKeyType(skEcdsaPub), SK_ECDSA_NISTP256);
  assert.equal(extractOpenSshPublicKeyType("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test"), "ssh-ed25519");
  assert.equal(isSkPublicKey(skEdPub), true);
  assert.equal(isSkPublicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test"), false);
});

test("extractOpenSshPublicKeyType recognizes OpenSSH sk certificate algorithms", () => {
  const skEdCert =
    "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA user@fido";
  const skEcdsaCert =
    "sk-ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTYtY2VydC12MDFAb3BlbnNzaC5jb20AAAA user@fido";
  assert.equal(extractOpenSshPublicKeyType(skEdCert), SK_SSH_ED25519);
  assert.equal(extractOpenSshPublicKeyType(skEcdsaCert), SK_ECDSA_NISTP256);
  assert.equal(isSkPublicKey(skEdCert), true);
  assert.equal(detectFidoSshKeyType({ publicKey: skEdCert }), "ED25519-SK");
  assert.equal(requiresFidoSshAgentAuth({ publicKey: skEcdsaCert }), true);
});

test("detectFidoSshKeyType maps vault and OpenSSH types", () => {
  assert.equal(detectFidoSshKeyType({ type: "ED25519-SK" }), "ED25519-SK");
  assert.equal(detectFidoSshKeyType({ publicKey: skEdPub }), "ED25519-SK");
  assert.equal(detectFidoSshKeyType({ publicKey: skEcdsaPub }), "ECDSA-SK");
  assert.equal(detectFidoSshKeyType({ type: "ED25519", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test" }), undefined);
});

/** Real-shaped PEM: sk type only appears after base64 decode (`@` not in b64 alphabet). */
function makeSkPrivatePem(algo: string): string {
  const raw = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${algo}`);
  const body = raw.toString("base64");
  // Guard: the PEM text must NOT contain the plain algorithm (skeptic regression).
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false);
  return pem;
}

test("isSkPrivateKey detects OpenSSH sk key handles", () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  assert.equal(isSkPrivateKey(pem), true);
  assert.equal(isSkPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"), false);
  assert.equal(requiresFidoSshAgentAuth({ publicKey: skEdPub }), true);
  assert.equal(requiresFidoSshAgentAuth({ privateKey: pem }), true);
  assert.equal(requiresFidoSshAgentAuth({ type: "ED25519", privateKey: "soft-key" }), false);
});

test("detectFidoSshKeyType reads sk algorithm from base64-only private PEM", () => {
  const edPem = makeSkPrivatePem(SK_SSH_ED25519);
  const ecPem = makeSkPrivatePem(SK_ECDSA_NISTP256);
  assert.equal(detectFidoSshKeyType({ privateKey: edPem }), "ED25519-SK");
  assert.equal(detectFidoSshKeyType({ privateKey: ecPem }), "ECDSA-SK");
});

test("decodeOpenSshPrivateKeyBody works without Node Buffer (renderer)", () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const originalBuffer = globalThis.Buffer;
  // @ts-expect-error intentional renderer simulation
  delete globalThis.Buffer;
  try {
    assert.equal(typeof globalThis.Buffer, "undefined");
    const decoded = decodeOpenSshPrivateKeyBody(pem);
    assert.ok(decoded);
    assert.equal(decoded.includes(SK_SSH_ED25519), true);
    assert.equal(detectFidoSshKeyType({ privateKey: pem }), "ED25519-SK");
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});
