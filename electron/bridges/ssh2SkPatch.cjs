/**
 * Patch ssh2's Protocol.authPK to support OpenSSH Security Key (sk-*) signature layouts.
 *
 * ssh2 assumes the SSH "signature" field is always:
 *   string sig_alg, string sig_blob
 *
 * OpenSSH sk-ecdsa/webauthn-sk signatures include extra fields after the
 * inner signature string, e.g.:
 *   string sig_alg, string ecdsa_sig, byte flags, uint32 counter, ...
 *
 * Without this patch, sshd will reject with "parse packet: invalid format".
 */

const Protocol = require("ssh2/lib/protocol/Protocol.js");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");
const { MESSAGE } = require("ssh2/lib/protocol/constants.js");
const { sendPacket, writeUInt32BE } = require("ssh2/lib/protocol/utils.js");

const PATCH_GUARD = "__netcattySsh2SkAuthPkPatchApplied";
if (!globalThis[PATCH_GUARD]) {
  globalThis[PATCH_GUARD] = true;

  const originalAuthPK = Protocol.prototype.authPK;

  // Only patch algorithms we intentionally support (OpenSSH PROTOCOL.u2f).
  const SK_SIG_ALGOS = new Set([
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "webauthn-sk-ecdsa-sha2-nistp256@openssh.com",
  ]);

  Protocol.prototype.authPK = function authPK(username, pubKey, keyAlgo, cbSign) {
    if (this._server) throw new Error("Client-only method called in server mode");

    if (typeof keyAlgo === "function") {
      cbSign = keyAlgo;
      keyAlgo = undefined;
    }

    // Preserve original behavior for the "check" packet or non-SK algorithms.
    if (!cbSign) return originalAuthPK.call(this, username, pubKey, keyAlgo);

    const parsedKey = parseKey(pubKey);
    if (parsedKey instanceof Error) throw new Error("Invalid key");

    const keyType = parsedKey.type;
    const pubKeyBlob = parsedKey.getPublicSSH();
    if (!keyAlgo) keyAlgo = keyType;

    if (!SK_SIG_ALGOS.has(keyAlgo)) {
      return originalAuthPK.call(this, username, parsedKey, keyAlgo, cbSign);
    }

    const userLen = Buffer.byteLength(username);
    const algoLen = Buffer.byteLength(keyAlgo);
    const pubKeyLen = pubKeyBlob.length;
    const sessionID = this._kex.sessionID;
    const sesLen = sessionID.length;

    // Data to be signed = string(sessionID) || USERAUTH_REQUEST fields (up to pubkey).
    const signData = Buffer.allocUnsafe(
      4 + sesLen
        + 1 + 4 + userLen
        + 4 + 14
        + 4 + 9
        + 1
        + 4 + algoLen
        + 4 + pubKeyLen
    );

    let p = 0;
    writeUInt32BE(signData, sesLen, p);
    signData.set(sessionID, p += 4);
    p += sesLen;

    signData[p] = MESSAGE.USERAUTH_REQUEST;

    writeUInt32BE(signData, userLen, ++p);
    signData.utf8Write(username, p += 4, userLen);

    writeUInt32BE(signData, 14, p += userLen);
    signData.utf8Write("ssh-connection", p += 4, 14);

    writeUInt32BE(signData, 9, p += 14);
    signData.utf8Write("publickey", p += 4, 9);

    signData[p += 9] = 1;

    writeUInt32BE(signData, algoLen, ++p);
    signData.utf8Write(keyAlgo, p += 4, algoLen);

    writeUInt32BE(signData, pubKeyLen, p += algoLen);
    signData.set(pubKeyBlob, p += 4);

    cbSign(signData, (signatureTail) => {
      // For OpenSSH SK signature algorithms, the signature field payload is:
      //   string sig_alg || <tail>
      // where <tail> begins with string(ecdsa_signature) and includes extra fields
      // (flags/counter/origin/clientData/extensions).
      if (!Buffer.isBuffer(signatureTail)) signatureTail = Buffer.from(signatureTail);

      const tailLen = signatureTail.length;
      const sigPayloadLen = 4 + algoLen + tailLen;

      const payloadLen =
        1 + 4 + userLen
          + 4 + 14
          + 4 + 9
          + 1
          + 4 + algoLen
          + 4 + pubKeyLen
          + 4 + sigPayloadLen;

      p = this._packetRW.write.allocStart;
      const packet = this._packetRW.write.alloc(payloadLen);

      packet[p] = MESSAGE.USERAUTH_REQUEST;

      writeUInt32BE(packet, userLen, ++p);
      packet.utf8Write(username, p += 4, userLen);

      writeUInt32BE(packet, 14, p += userLen);
      packet.utf8Write("ssh-connection", p += 4, 14);

      writeUInt32BE(packet, 9, p += 14);
      packet.utf8Write("publickey", p += 4, 9);

      packet[p += 9] = 1;

      writeUInt32BE(packet, algoLen, ++p);
      packet.utf8Write(keyAlgo, p += 4, algoLen);

      writeUInt32BE(packet, pubKeyLen, p += algoLen);
      packet.set(pubKeyBlob, p += 4);

      // signature: string(sig_payload)
      writeUInt32BE(packet, sigPayloadLen, p += pubKeyLen);

      // sig_payload: string(sig_alg) || signatureTail
      writeUInt32BE(packet, algoLen, p += 4);
      packet.utf8Write(keyAlgo, p += 4, algoLen);
      packet.set(signatureTail, p += algoLen);

      this._authsQueue.push("publickey");
      this._debug && this._debug("Outbound: Sending USERAUTH_REQUEST (publickey)");
      sendPacket(this, this._packetRW.write.finalize(packet));
    });
  };
}

