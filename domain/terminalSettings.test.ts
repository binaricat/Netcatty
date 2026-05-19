import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTerminalSettings } from "./models";

test("normalizeTerminalSettings disables prompt line breaks by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.forcePromptNewLine, false);
});

