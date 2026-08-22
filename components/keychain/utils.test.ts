import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SK_ECDSA_NISTP256, SK_SSH_ED25519 } from "../../domain/fidoSsh.ts";
import { detectKeyType, resolveImportedKeyType } from "./utils.ts";

/** Real OpenSSH shape: algorithm only after base64 decode. */
function makeSkPrivatePem(algo: string): string {
  const body = Buffer.from(
    `openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${algo}`,
  ).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false);
  return pem;
}

test("resolveImportedKeyType prefers FIDO detection over seeded ED25519 draft", () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  // Simulate openImport seed + paste import (handleImport path).
  const seededDraftType = "ED25519" as const;
  const detected = resolveImportedKeyType({ privateKey: pem });
  assert.equal(detected, "ED25519-SK");
  // Product rule: material wins; never keep seeded ED25519 when SK is detected.
  const savedType = detected; // same as fixed handleImport
  assert.notEqual(savedType, seededDraftType);
  assert.equal(savedType, "ED25519-SK");
});

test("resolveImportedKeyType distinguishes ECDSA-SK from base64-only PEM", () => {
  assert.equal(
    resolveImportedKeyType({ privateKey: makeSkPrivatePem(SK_ECDSA_NISTP256) }),
    "ECDSA-SK",
  );
});

test("detectKeyType uses the same material path for file drop", () => {
  assert.equal(detectKeyType(makeSkPrivatePem(SK_SSH_ED25519)), "ED25519-SK");
  assert.equal(detectKeyType("-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----"), "RSA");
});

test("resolveImportedKeyType keeps soft keys", () => {
  assert.equal(
    resolveImportedKeyType({
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    }),
    "ED25519",
  );
});

test("KeychainManager handleImport uses material type not seeded draft type", () => {
  const source = readFileSync(join(import.meta.dirname, "../KeychainManager.tsx"), "utf8");
  // Must resolve from material; must not keep draftKey.type first (openImport seeds ED25519).
  assert.match(source, /resolveImportedKeyType/);
  assert.doesNotMatch(
    source,
    /type:\s*\(draftKey\.type as KeyType\)\s*\|\|\s*detectedType/,
  );
  assert.match(source, /type:\s*detectedType/);
});
