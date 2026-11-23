"use strict";

// Extract only the public-key wire blob for fingerprinting, never CA trust or
// certificate validation. ssh2's getPublicSSH() preserves the full certificate,
// and its internal base-type helper is not exported. Keep this byte-only helper
// shared by Electron and the renderer so migration uses exactly the same bytes.
// Layouts: OpenSSH PROTOCOL.certkeys (v00/v01) and PROTOCOL.u2f (SK).
function extractCertificatePublicKey(blob) {
  let offset = 0;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const skip = (length) => {
    if (offset + length > blob.length) throw new Error("Truncated SSH key");
    offset += length;
  };
  const readString = () => {
    skip(4);
    const length = view.getUint32(offset - 4, false);
    const start = offset;
    skip(length);
    return blob.subarray(start, offset);
  };
  const ascii = (bytes) => String.fromCharCode(...bytes);

  try {
    const typeBytes = readString();
    if (typeBytes.length > 128) return null;
    const match = ascii(typeBytes).match(/^(.*)-cert-v0([01])@openssh\.com$/);
    if (!match) return null;
    let baseType = match[1];
    const v01 = match[2] === "1";
    if (/^rsa-sha2-(256|512)$/.test(baseType)) baseType = "ssh-rsa";
    if (baseType === "sk-ssh-ed25519" || baseType === "sk-ecdsa-sha2-nistp256") {
      baseType += "@openssh.com";
    }
    let fields;
    switch (baseType) {
      case "ssh-rsa": fields = 2; break;
      case "ssh-dss": fields = 4; break;
      case "ssh-ed25519": fields = 1; break;
      case "sk-ssh-ed25519@openssh.com": fields = 2; break;
      case "sk-ecdsa-sha2-nistp256@openssh.com": fields = 3; break;
      case "ecdsa-sha2-nistp256":
      case "ecdsa-sha2-nistp384":
      case "ecdsa-sha2-nistp521": fields = 2; break;
      default: return null;
    }

    // v00 put its nonce after the constraints, not before the key material.
    if (v01) readString();
    const keyStart = offset;
    for (let i = 0; i < fields; i += 1) {
      const field = readString();
      const isApplication = baseType.startsWith("sk-") && i === fields - 1;
      if (!field.length && !isApplication) return null;
      if (i === 0 && baseType.includes("ed25519") && field.length !== 32) return null;
      if (i === 0 && baseType.includes("ecdsa")) {
        const curve = baseType.replace(/^sk-/, "").replace(/@openssh\.com$/, "").replace(/^ecdsa-sha2-/, "");
        if (field.length > 8 || ascii(field) !== curve) return null;
      }
    }
    const keyEnd = offset;
    // Check the outer envelope too; truncated/unsupported certificates retain
    // their full-blob fingerprint rather than gaining an inner-key match.
    if (v01) skip(8); // serial
    skip(4); // host/user type
    readString(); // key ID
    readString(); // principals
    skip(16); // validity
    readString(); // critical options (v00 constraints)
    readString(); // extensions (v00 nonce)
    readString(); // reserved
    if (!readString().length || !readString().length || offset !== blob.length) return null;

    const result = new Uint8Array(4 + baseType.length + keyEnd - keyStart);
    new DataView(result.buffer).setUint32(0, baseType.length, false);
    for (let i = 0; i < baseType.length; i += 1) result[4 + i] = baseType.charCodeAt(i);
    result.set(blob.subarray(keyStart, keyEnd), 4 + baseType.length);
    return result;
  } catch {
    return null;
  }
}

exports.extractCertificatePublicKey = extractCertificatePublicKey;
