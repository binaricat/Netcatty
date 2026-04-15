import assert from "node:assert/strict";
import test from "node:test";

import {
  endDraftSend,
  tryBeginDraftSend,
} from "./draftSendGate.ts";

test("draft send gate allows only one in-flight draft send at a time", () => {
  const gate = { current: false };

  assert.equal(tryBeginDraftSend(gate), true);
  assert.equal(tryBeginDraftSend(gate), false);

  endDraftSend(gate);

  assert.equal(tryBeginDraftSend(gate), true);
});
