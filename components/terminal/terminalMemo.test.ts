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

test("terminal memo refreshes when pane visibility changes", () => {
  // Solo tab switches only flip isVisible. Skipping that comparison leaves
  // isVisibleRef stale and skips tab-return recovery (#1985).
  assert.equal(
    terminalPropsAreEqual(baseProps, { ...baseProps, isVisible: false }),
    false,
  );
});

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

test("terminal memo refreshes when a popup vault finishes hydrating", () => {
  assert.equal(
    terminalPropsAreEqual(baseProps, { ...baseProps, vaultInitializedOverride: true }),
    false,
  );
});

test("terminal memo refreshes when terminal context reader callback changes", () => {
  assert.equal(
    terminalPropsAreEqual(baseProps, {
      ...baseProps,
      onTerminalContextReaderChange: () => {},
    }),
    false,
  );
});

test('terminal memo refreshes for intense foreground edits and toggles', async () => {
  const { TERMINAL_THEMES } = await import('../../infrastructure/config/terminalThemes');
  const theme = TERMINAL_THEMES[0];
  for (const field of ['terminalTheme', 'appearanceTheme'] as const) {
    const props = { ...baseProps, [field]: theme };
    const enabled = { ...props, [field]: { ...theme, colors: { ...theme.colors, foregroundIntense: '#ff8800' } } };
    const recolored = { ...props, [field]: { ...theme, colors: { ...theme.colors, foregroundIntense: '#00ff00' } } };
    assert.equal(terminalPropsAreEqual(props, enabled), false);
    assert.equal(terminalPropsAreEqual(enabled, recolored), false);
    assert.equal(terminalPropsAreEqual(enabled, props), false);
    assert.equal(terminalPropsAreEqual(enabled, { ...enabled }), true);
  }
});
