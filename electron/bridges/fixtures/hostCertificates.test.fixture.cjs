const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let sshKeygenSkip = false;
try {
  execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
} catch (error) {
  if (error.code === "ENOENT") sshKeygenSkip = "ssh-keygen is not installed";
}

const sshString = (value) => {
  const body = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};

// Real local certificates, with no server/network or security-key device.
function mintHostCertificates(t, { type = "ed25519", bits, sk = false, user = false } = {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, ".hostcert-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keygen = (...args) => execFileSync("ssh-keygen", ["-q", ...args], { stdio: "pipe" });
  const ca = path.join(dir, "ca");
  keygen("-t", "ed25519", "-N", "", "-f", ca);
  const readKey = (file) => {
    const line = fs.readFileSync(file, "utf8").trim();
    const [keyType, body] = line.split(/\s+/);
    return { line, keyType, blob: Buffer.from(body, "base64") };
  };
  const mint = (name, validity, serial) => {
    const host = path.join(dir, name);
    if (!fs.existsSync(host)) {
      keygen("-t", type, ...(bits ? ["-b", String(bits)] : []), "-N", "", "-f", host);
      if (sk) {
        const plain = readKey(`${host}.pub`);
        const keyMaterial = plain.blob.subarray(4 + plain.keyType.length);
        const skType = `sk-${plain.keyType}@openssh.com`;
        const blob = Buffer.concat([sshString(skType), keyMaterial, sshString("ssh:netcatty-test")]);
        fs.writeFileSync(`${host}.pub`, `${skType} ${blob.toString("base64")}\n`);
      }
    }
    keygen("-s", ca, "-I", "netcatty-hostcert", ...(user ? [] : ["-h"]),
      "-n", "127.0.0.1", "-V", validity, "-z", String(serial), `${host}.pub`);
    const cert = readKey(`${host}-cert.pub`);
    const listing = execFileSync("ssh-keygen", ["-L", "-f", `${host}-cert.pub`], { encoding: "utf8" });
    const publicKeyFingerprint = listing.match(/Public key: .* SHA256:(\S+)/)?.[1];
    if (!publicKeyFingerprint) throw new Error("Missing ssh-keygen certificate fingerprint");
    return { ...cert, publicKeyFingerprint, plain: readKey(`${host}.pub`) };
  };
  return {
    first: mint("host", "20250101:20260101", 1),
    renewed: mint("host", "20260101:20270101", 2),
    different: mint("other", "20260101:20270101", 3),
  };
}

// Legacy v00 is no longer emitted by ssh-keygen. This follows the original
// PROTOCOL.certkeys layout: key material first, nonce after constraints.
function legacyCertificate(keyType, keyFields) {
  const blob = Buffer.concat([
    sshString(`${keyType}-cert-v00@openssh.com`),
    ...keyFields.map(sshString),
    Buffer.from([0, 0, 0, 2]),
    sshString("legacy"), sshString(""), Buffer.alloc(16),
    sshString(""), sshString("nonce"), sshString(""),
    sshString("signing key"), sshString("signature"),
  ]);
  return {
    blob,
    plain: Buffer.concat([sshString(keyType), ...keyFields.map(sshString)]),
    line: `${keyType}-cert-v00@openssh.com ${blob.toString("base64")}`,
  };
}

module.exports = { mintHostCertificates, legacyCertificate, sshString, sshKeygenSkip };
