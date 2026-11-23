import assert from "node:assert/strict";
import test from "node:test";

import {
  isIdleShellReadyForCommandInjection,
  isShellPromptReadyForInsertion,
} from "./terminalCommandInjectionReady.ts";

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
    isIdleShellReadyForCommandInjection({ ...ready, afterCursorInputLength: 14 }),
    false,
  );
  assert.equal(
    isIdleShellReadyForCommandInjection({ ...ready, hasLiveTerminal: false }),
    false,
  );
});

test("draft insertion still blocks sensitive prompts, alt-screen, and a missing prompt", () => {
  const draft = {
    hasLiveTerminal: true,
    alternateScreenActive: false,
    isAtPrompt: true,
    userInputLength: 4,
    pendingTypedInputLength: 2,
  };
  assert.equal(isShellPromptReadyForInsertion(draft), true);
  assert.equal(isIdleShellReadyForCommandInjection(draft), false);
  assert.equal(
    isShellPromptReadyForInsertion({ ...draft, sensitiveInputActive: true }),
    false,
  );
  assert.equal(
    isShellPromptReadyForInsertion({ ...draft, alternateScreenActive: true }),
    false,
  );
  assert.equal(isShellPromptReadyForInsertion({ ...draft, isAtPrompt: false }), false);
  assert.equal(
    isShellPromptReadyForInsertion({ ...draft, hasLiveTerminal: false }),
    false,
  );
});
