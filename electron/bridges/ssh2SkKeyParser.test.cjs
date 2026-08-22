"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseKey,
  getOpenSSHCertSignatureAlgorithm,
} = require("ssh2/lib/protocol/keyParser.js");

function buildSkEd25519PublicLine() {
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 9);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} netcatty@sk`;
}

function buildSkEcdsaPublicLine() {
  // Uncompressed P-256 point: 0x04 || X(32) || Y(32)
  const point = Buffer.alloc(65, 0);
  point[0] = 0x04;
  point[64] = 1;
  const type = Buffer.from("sk-ecdsa-sha2-nistp256@openssh.com");
  const curve = Buffer.from("nistp256");
  const app = Buffer.from("ssh:");
  const parts = [type, curve, point, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ecdsa-sha2-nistp256@openssh.com ${buf.toString("base64")} netcatty@sk`;
}

test("ssh2 parseKey accepts sk-ssh-ed25519 public keys", () => {
  const key = parseKey(buildSkEd25519PublicLine());
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ssh-ed25519@openssh.com");
  assert.equal(typeof key.getPublicSSH, "function");
  assert.equal(key.getApplication?.(), "ssh:");
  const signErr = key.sign(Buffer.from("challenge"));
  assert.equal(signErr instanceof Error, true);
  assert.match(String(signErr.message), /security-key|ssh-agent|FIDO/i);
});

test("ssh2 parseKey accepts sk-ecdsa-sha2-nistp256 public keys", () => {
  const key = parseKey(buildSkEcdsaPublicLine());
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ecdsa-sha2-nistp256@openssh.com");
  assert.equal(key.getApplication?.(), "ssh:");
});

function buildSkEd25519CertPublicLine() {
  // Minimal OpenSSH SK cert wire shape: type, nonce, then SK public fields.
  const type = Buffer.from("sk-ssh-ed25519-cert-v01@openssh.com");
  const nonce = Buffer.alloc(16, 7);
  const pub = Buffer.alloc(32, 9);
  const app = Buffer.from("ssh:");
  const parts = [type, nonce, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  return `sk-ssh-ed25519-cert-v01@openssh.com ${buf.toString("base64")} netcatty@sk-cert`;
}

test("ssh2 parseKey accepts OpenSSH-order SK certificate public keys", () => {
  const line = buildSkEd25519CertPublicLine();
  const certBlob = Buffer.from(line.split(/\s+/)[1], "base64");
  const key = parseKey(line);
  assert.equal(key instanceof Error, false, key instanceof Error ? key.message : "");
  assert.equal(key.type, "sk-ssh-ed25519-cert-v01@openssh.com");
  assert.equal(key.getApplication?.(), "ssh:");
  assert.deepEqual(key.getPublicSSH(), certBlob);
});

test("ssh2 maps SK certificate identities to full wire signature algorithms", () => {
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ssh-ed25519-cert-v01@openssh.com"),
    "sk-ssh-ed25519@openssh.com",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ecdsa-sha2-nistp256-cert-v01@openssh.com"),
    "sk-ecdsa-sha2-nistp256@openssh.com",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("rsa-sha2-256-cert-v01@openssh.com"),
    "rsa-sha2-256",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("ecdsa-sha2-nistp256-cert-v01@openssh.com"),
    "ecdsa-sha2-nistp256",
  );
  assert.equal(
    getOpenSSHCertSignatureAlgorithm("sk-ssh-ed25519@openssh.com"),
    "sk-ssh-ed25519@openssh.com",
  );
});
