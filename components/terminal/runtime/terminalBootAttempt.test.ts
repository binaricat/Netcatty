import test from "node:test";
import assert from "node:assert/strict";

import {
  beginTerminalBootAttempt,
  invalidateTerminalBootAttempt,
  isTerminalBootAttemptCurrent,
} from "./terminalBootAttempt";

const createBootAttemptRefs = () => ({
  bootTokenRef: { current: null as symbol | null },
  isBootActiveRef: { current: false },
});

test("beginning a terminal boot attempt activates a fresh current generation", () => {
  const refs = createBootAttemptRefs();

  const firstToken = beginTerminalBootAttempt(refs, "first");
  const replacementToken = beginTerminalBootAttempt(refs, "replacement");

  assert.notEqual(replacementToken, firstToken);
  assert.equal(refs.bootTokenRef.current, replacementToken);
  assert.equal(refs.isBootActiveRef.current, true);
  assert.equal(isTerminalBootAttemptCurrent(refs, firstToken), false);
  assert.equal(isTerminalBootAttemptCurrent(refs, replacementToken), true);
});

test("invalidating a terminal boot attempt clears its active generation", () => {
  const refs = createBootAttemptRefs();
  const token = beginTerminalBootAttempt(refs);

  invalidateTerminalBootAttempt(refs);

  assert.equal(refs.bootTokenRef.current, null);
  assert.equal(refs.isBootActiveRef.current, false);
  assert.equal(isTerminalBootAttemptCurrent(refs, token), false);
});
