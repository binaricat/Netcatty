import assert from "node:assert/strict";
import test from "node:test";

import { isIdleShellReadyForCommandInjection } from "./terminalCommandInjectionReady.ts";

test("idle shell is ready only at a clean primary-screen prompt", () => {
  assert.equal(
    isIdleShellReadyForCommandInjection({
      hasLiveTerminal: true,
      alternateScreenActive: false,
      isAtPrompt: true,
      userInputLength: 0,
    }),
    true,
  );
});

test("rejects sensitive prompts, alt-screen TUIs, partial input, and missing terminals", () => {
  const ready = {
    hasLiveTerminal: true,
    alternateScreenActive: false,
    isAtPrompt: true,
    userInputLength: 0,
  };
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, sensitiveInputActive: true }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, alternateScreenActive: true }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, isAtPrompt: false }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, userInputLength: 3 }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, pendingTypedInputLength: 2 }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, hasLiveTerminal: false }),
    false,
  );
});
