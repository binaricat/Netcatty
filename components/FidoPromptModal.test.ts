import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("FidoPromptModal ships PIN and touch UI wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "FidoPromptModal.tsx"), "utf8");
  assert.match(source, /kind === "touch"/);
  assert.match(source, /fido-pin-input/);
  assert.match(source, /fido\.prompt\.pinTitle/);
  assert.match(source, /fido\.prompt\.touchTitle/);
  assert.match(source, /onSubmit\(request\.requestId/);
  assert.match(source, /onCancel\(request\.requestId/);
});

test("AppView mounts FidoPromptModal", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../application/app/AppView.tsx"),
    "utf8",
  );
  assert.match(source, /FidoPromptModal/);
  assert.match(source, /fidoPromptQueue/);
  assert.match(source, /handleFidoPromptSubmit/);
});

test("GenerateStandardPanel exposes FIDO options", () => {
  const source = readFileSync(
    join(import.meta.dirname, "keychain/GenerateStandardPanel.tsx"),
    "utf8",
  );
  assert.match(source, /ED25519-SK/);
  assert.match(source, /ECDSA-SK/);
  assert.match(source, /resident/);
  assert.match(source, /verifyRequired/);
  assert.match(source, /fidoHint/);
});
