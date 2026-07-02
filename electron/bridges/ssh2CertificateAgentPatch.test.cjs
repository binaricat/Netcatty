"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { AgentProtocol } = require("ssh2/lib/agent.js");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

const ECDSA_CERT_LINE = "ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAKGVjZHNhLXNoYTItbmlzdHAyNTYtY2VydC12MDFAb3BlbnNzaC5jb20AAAAgSkptPjkhM3ZnXER1QSNpaSg0JzJ9Z3dLTU0oKkpCYGIAAAAIbmlzdHAyNTYAAABBBAMxijjYHek6JS1XtFt1YPJuDs7Zkpg+UMz/b5jzTB+Srl0hT9V4kexCpwyMDnx8gd3k4daGWZXxsesQaQGC4rX0cwh4uddx3gAAAAEAAAAQbWVAaW1sb25naGFvLmNvbQAAAAgAAAAEcm9vdAAAAABqRmpZAAAAAGpGlNQAAAAAAAAAggAAABVwZXJtaXQtWDExLWZvcndhcmRpbmcAAAAAAAAAF3Blcm1pdC1hZ2VudC1mb3J3YXJkaW5nAAAAAAAAABZwZXJtaXQtcG9ydC1mb3J3YXJkaW5nAAAAAAAAAApwZXJtaXQtcHR5AAAAAAAAAA5wZXJtaXQtdXNlci1yYwAAAAAAAAAAAAAAaAAAABNlY2RzYS1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQQkWxbD3AqBZgxF3n5W1Tm6EaRShuvZjkvILa6IcVrnsLnPG1IFBaYDw3nWze+3ih3RA55xnnPEPWHKOS6VLunmAAAAZQAAABNlY2RzYS1zaGEyLW5pc3RwMjU2AAAASgAAACEA4JLPuC1ZEh6viYhY8lK0SeevuNpSTiIIushCe78Jmj0AAAAhAOFEBe05MOCxfaVo4gptJKz2BjR3hFJrMb0CEukNgcFo root";

function keyBlobFromLine(line) {
  return Buffer.from(line.split(/\s+/)[1], "base64");
}

function writeString(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  data.copy(buf, 4);
  return buf;
}

function readString(buf, offset) {
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  return { value: buf.subarray(start, start + len), next: start + len };
}

function signRequestFor(key, options = {}) {
  const protocol = new AgentProtocol(true);
  protocol.sign(key, Buffer.from("payload"), options, () => {});
  const request = protocol.read();
  assert.ok(request, "expected agent sign request");
  assert.equal(request[4], 13);
  return request;
}

test("ssh2 parses OpenSSH certificate identities from ssh-agent without dropping the certificate blob", () => {
  const certBlob = keyBlobFromLine(ECDSA_CERT_LINE);

  for (const input of [ECDSA_CERT_LINE, certBlob]) {
    const key = parseKey(input);
    assert.equal(key instanceof Error, false, key.message);
    assert.equal(key.type, "ecdsa-sha2-nistp256-cert-v01@openssh.com");
    assert.deepEqual(key.getPublicSSH(), certBlob);
  }
});

test("ssh2 agent signing requests use the full certificate blob as the key identity", () => {
  const certBlob = keyBlobFromLine(ECDSA_CERT_LINE);

  const request = signRequestFor(certBlob);
  let parsed = readString(request, 5);
  assert.deepEqual(parsed.value, certBlob);
  parsed = readString(request, parsed.next);
  assert.equal(parsed.value.toString(), "payload");
  assert.equal(request.readUInt32BE(parsed.next), 0);
});

test("ssh2 agent signing requests pass RSA SHA2 flags for RSA certificate identities", () => {
  const rsaCertBlob = Buffer.concat([
    writeString("ssh-rsa-cert-v01@openssh.com"),
    writeString(Buffer.from("nonce")),
    writeString(Buffer.from([0x01, 0x00, 0x01])),
    writeString(Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0xaa)])),
  ]);

  const key = parseKey(rsaCertBlob);
  assert.equal(key instanceof Error, false, key.message);
  assert.equal(key.type, "ssh-rsa-cert-v01@openssh.com");
  assert.deepEqual(key.getPublicSSH(), rsaCertBlob);

  const request = signRequestFor(rsaCertBlob, { hash: "sha512" });
  let parsed = readString(request, 5);
  assert.deepEqual(parsed.value, rsaCertBlob);
  parsed = readString(request, parsed.next);
  assert.equal(parsed.value.toString(), "payload");
  assert.equal(request.readUInt32BE(parsed.next), 1 << 2);
});
