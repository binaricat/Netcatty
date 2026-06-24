"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasUserConfiguredKey } = require("./sshAuthHelper.cjs");

test("hasUserConfiguredKey is true for inline private key material", () => {
  assert.equal(hasUserConfiguredKey({ privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }), true);
});

test("hasUserConfiguredKey is false for empty or whitespace inline keys", () => {
  assert.equal(hasUserConfiguredKey({ privateKey: "" }), false);
  assert.equal(hasUserConfiguredKey({ privateKey: "   " }), false);
  assert.equal(hasUserConfiguredKey({}), false);
});

test("hasUserConfiguredKey is true for Keychain reference identity file paths", () => {
  assert.equal(
    hasUserConfiguredKey({ identityFilePaths: ["/Users/alice/.ssh/id_ed25519"] }),
    true,
  );
});

test("hasUserConfiguredKey is false for empty identity file path lists", () => {
  assert.equal(hasUserConfiguredKey({ identityFilePaths: [] }), false);
  assert.equal(hasUserConfiguredKey({ identityFilePaths: null }), false);
});

test("hasUserConfiguredKey prefers explicit inline key over empty paths", () => {
  assert.equal(
    hasUserConfiguredKey({
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      identityFilePaths: [],
    }),
    true,
  );
});
