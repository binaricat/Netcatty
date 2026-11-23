// Created: 2026-07-15
// Purpose: verify keyboard-interactive modal server prompt formatting.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import {
  keyboardInteractiveFieldLabel,
  keyboardInteractiveGuidance,
  totpFillPlacement,
  visibleTotpFillPlacements,
} from "./KeyboardInteractiveModal.tsx";

const modalSource = readFileSync(new URL("./KeyboardInteractiveModal.tsx", import.meta.url), "utf8");

test("keyboardInteractiveFieldLabel uses the cleaned last prompt line", () => {
  assert.equal(keyboardInteractiveFieldLabel("Secondary Authentication Password:", "Verification code"), "Secondary Authentication Password");
  assert.equal(keyboardInteractiveFieldLabel("JumpServer:\n| SMS code:", "Verification code"), "SMS code");
  assert.equal(keyboardInteractiveFieldLabel("[OTP Code]: ", "Verification code"), "OTP Code");
  assert.equal(keyboardInteractiveFieldLabel("   ", "Verification code"), "Verification code");
});

test("keyboard-interactive dialog shows a field label and an inline TOTP action", async () => {
  assert.doesNotMatch(modalSource, /<pre/);
  assert.match(modalSource, /keyboardInteractiveFieldLabel\(/);
  assert.match(modalSource, /keyboardInteractiveGuidance\(/);
  assert.match(modalSource, /data-totp-fill=\{fillPlacement\}/);
  assert.match(modalSource, /variant="secondary"/);
  assert.doesNotMatch(modalSource, /variant=\{fillPlacement/);
  assert.match(modalSource, /totpPrompt\.shared\.cjs/);
  const shared = require("../domain/totpPrompt.shared.cjs") as { NON_TOTP_PROMPT: RegExp };
  const runtime = require("../domain/totp.shared.cjs") as { NON_TOTP_PROMPT: RegExp };
  assert.equal(shared.NON_TOTP_PROMPT, runtime.NON_TOTP_PROMPT);
  assert.doesNotMatch(modalSource, /ring-primary/);
  assert.doesNotMatch(modalSource, /className="w-full"/);
  assert.doesNotMatch(modalSource, /onTypeTotp/);
});

test("keyboardInteractiveGuidance keeps directions that are not already the field label", () => {
  assert.equal(keyboardInteractiveGuidance({
    name: "bastion",
    hostname: "bastion",
    instructions: "",
    prompts: [{ prompt: "Verification code:", echo: false }],
  }), "");
  assert.equal(keyboardInteractiveGuidance({
    name: "Duo Security",
    hostname: "vpn.example",
    instructions: "1. Duo Push\n2. SMS\nPasscode or option (1-3):",
    prompts: [{ prompt: "Passcode or option (1-3):", echo: true }],
  }), "Duo Security\n1. Duo Push\n2. SMS");
  assert.equal(keyboardInteractiveGuidance({
    name: "host",
    hostname: "other",
    instructions: "| Verification code:",
    prompts: [{ prompt: "Verification code:", echo: false }],
  }), "host");
  assert.equal(keyboardInteractiveGuidance({
    name: "bastion",
    hostname: "bastion",
    instructions: "",
    prompts: [{ prompt: "1. OTP\n2. SMS\nOption> ", echo: true }],
  }), "1. OTP\n2. SMS");
  assert.equal(keyboardInteractiveGuidance({
    name: "bastion",
    hostname: "bastion",
    instructions: "1. OTP",
    prompts: [{ prompt: "1. OTP\nOption>", echo: true }],
  }), "1. OTP");
});

test("TOTP fill stays off password prompts and prefers verification prompts", () => {
  assert.equal(totpFillPlacement({ prompt: "Password:", echo: false }), "hidden");
  assert.equal(totpFillPlacement({ prompt: "Verification code:", echo: false }), "preferred");
  assert.equal(totpFillPlacement({ prompt: "[OTP Code]:", echo: false }), "preferred");
  assert.equal(totpFillPlacement({ prompt: "One-time password:", echo: false }), "preferred");
  assert.equal(totpFillPlacement({ prompt: "SMS code:", echo: false }), "hidden");
  assert.equal(totpFillPlacement({ prompt: "1. OTP\n2. SMS\nOption> ", echo: true }), "hidden");
  assert.equal(totpFillPlacement({ prompt: "[Y/n]", echo: true }), "hidden");
  assert.equal(totpFillPlacement({ prompt: "1. OTP\nVerification code:", echo: false }), "preferred");
  assert.equal(totpFillPlacement({ prompt: "Response:", echo: true }), "available");
  assert.deepEqual(visibleTotpFillPlacements([
    { prompt: "Password:", echo: false },
    { prompt: "Verification code:", echo: false },
  ]), ["hidden", "preferred"]);
  assert.deepEqual(visibleTotpFillPlacements([
    { prompt: "Password:", echo: false },
  ]), ["hidden"]);
});

test("keyboard-interactive modal cannot be dismissed by outside click or Escape", () => {
  assert.match(modalSource, /onOpenChange=\{\(\) => \{\/\* intentionally non-dismissable \*\/\}\}/);
  assert.match(modalSource, /onInteractOutside=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(modalSource, /onEscapeKeyDown=\{\(e\) => e\.preventDefault\(\)\}/);
});
