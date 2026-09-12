import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";

import {
  craftMobaConnectionKey,
  craftMobaSessionPKey,
  decodeMobaPlaintext,
  decryptMobaStoredSecret,
  decryptMobaWeakCipher,
  sha512,
} from "./mobaXtermCrypto.ts";

test("sha512 matches Node for MobaXterm key material", () => {
  const samples = ["12345678", "master-password", ""];
  for (const sample of samples) {
    assert.deepEqual(
      Buffer.from(sha512(Buffer.from(sample, "utf8"))),
      createHash("sha512").update(sample, "utf8").digest(),
    );
  }
});

test("master-password AES decrypts HyperSine session and credential vectors", () => {
  assert.equal(
    decryptMobaStoredSecret({
      ciphertext: "1du11XKQBOxud/FWh4ouWA==",
      masterPassword: "12345678",
    }),
    "Lw3+cZ2s.w@U@f]U",
  );
  assert.equal(
    decryptMobaStoredSecret({
      ciphertext: "0XROpGmLAYVx",
      masterPassword: "12345678",
    }),
    "HyperSine",
  );
});

test("master-password AES decrypts the v25 random-IV format", () => {
  const masterPassword = "netcatty-master";
  const plaintext = "imported-secret";
  const key = createHash("sha512").update(masterPassword, "utf8").digest().subarray(0, 32);
  const prefix = "_@ABCDEFGHIJKLMNOPQR";
  const iv = Buffer.from(prefix.slice(2, 18), "latin1");
  const cipher = createCipheriv("aes-256-cfb8", key, iv);
  cipher.setAutoPadding(false);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const stored = `${prefix}${body.toString("base64").replaceAll("+", "@").replaceAll("/", "_")}`;

  assert.equal(
    decryptMobaStoredSecret({ ciphertext: stored, masterPassword }),
    plaintext,
  );
});

test("weak SessionP cipher decrypts the published credential vector", () => {
  const key = craftMobaSessionPKey("165821882556840");
  assert.equal(
    decodeMobaPlaintext(decryptMobaWeakCipher(
      "bSj4VWbHezNH3tTY9Nil2RzJX57p7/S6KqMw8VsiT/WH+I8p03pqnInAu",
      key,
    )),
    "HyperSine",
  );
});

test("weak connection cipher decrypts the published session-password vector", () => {
  const key = craftMobaConnectionKey("DoubleSine", "ShadowSurface", "root", "45.32.110.171");
  assert.equal(
    decodeMobaPlaintext(decryptMobaWeakCipher(
      "F0+wuBvbe9qPW6ypiOeYHTHhKdShRc/nXaM1Ky1jeTfw46TzQoSesX9buGm0WW36yP4lhH70ZCHZpEo4wLJhIl1",
      key,
    )),
    "Lw3+cZ2s.w@U@f]U",
  );
});

test("wrong master password does not look like a saved secret", () => {
  for (const masterPassword of ["wrong-password", "wrong0", "wrong25", "x", "0"]) {
    assert.equal(
      decryptMobaStoredSecret({
        ciphertext: "1du11XKQBOxud/FWh4ouWA==",
        masterPassword,
      }),
      null,
      `session ciphertext accepted garbage for ${masterPassword}`,
    );
    assert.equal(
      decryptMobaStoredSecret({
        ciphertext: "0XROpGmLAYVx",
        masterPassword,
      }),
      null,
      `credential ciphertext accepted garbage for ${masterPassword}`,
    );
  }
});

test("decodeMobaPlaintext rejects an interior NUL left by a wrong AES key", () => {
  assert.equal(
    decodeMobaPlaintext(Uint8Array.from([0x4d, 0x29, 0x38, 0x25, 0x00, 0x72, 0x33, 0x8a, 0xa8])),
    null,
  );
  assert.equal(
    decodeMobaPlaintext(Uint8Array.from([0x48, 0x69, 0x00, 0x00])),
    "Hi",
  );
});

test("master-password AES keeps leading and trailing whitespace in the key", () => {
  const masterPassword = " 12345678 ";
  const plaintext = "spaced-master";
  const key = createHash("sha512").update(masterPassword, "utf8").digest().subarray(0, 32);
  const iv = createCipheriv("aes-256-ecb", key, null).update(Buffer.alloc(16));
  const cipher = createCipheriv("aes-256-cfb8", key, iv);
  cipher.setAutoPadding(false);
  const stored = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]).toString("base64");

  assert.equal(
    decryptMobaStoredSecret({ ciphertext: stored, masterPassword }),
    plaintext,
  );
  assert.equal(
    decryptMobaStoredSecret({ ciphertext: stored, masterPassword: masterPassword.trim() }),
    null,
  );
});

test("decodeMobaPlaintext rejects high-bit Latin-1 that is not UTF-8", () => {
  assert.equal(
    decodeMobaPlaintext(Uint8Array.from([0xd7, 0xf4, 0x5f, 0xb8, 0x77, 0xf9, 0x9c, 0xc9, 0x40])),
    null,
  );
  assert.equal(decodeMobaPlaintext(Uint8Array.from([0x48, 0x69])), "Hi");
});
