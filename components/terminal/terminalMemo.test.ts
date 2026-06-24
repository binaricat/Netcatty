import assert from "node:assert/strict";
import test from "node:test";

import { terminalPropsAreEqual } from "./terminalMemo.ts";
import type { TerminalProps } from "./terminalHelpers.ts";

const baseProps = {
  host: {},
  keys: [],
  identities: [],
  snippets: [],
  isVisible: true,
  fontFamilyId: "default",
  fontSize: 14,
  terminalTheme: {},
  sessionId: "session-1",
  showSelectionAIAction: true,
} as unknown as TerminalProps;

test("terminal memo refreshes when selection AI action visibility changes", () => {
  assert.equal(
    terminalPropsAreEqual(baseProps, { ...baseProps, showSelectionAIAction: false }),
    false,
  );
});

test("terminal memo refreshes when restored local shell type changes", () => {
  assert.equal(
    terminalPropsAreEqual(baseProps, { ...baseProps, shellType: "powershell" }),
    false,
  );
});
