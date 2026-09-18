/**
 * xterm.js arms its `insertText` dedupe guard (`_keyDownSeen`) on every
 * keydown and only clears it on keyup. A pure modifier keydown never emits
 * text itself, but on Windows Sogou Pinyin commits the pending preedit text
 * when Shift toggles Chinese/English mode — and the composed `input` event
 * that carries the commit is delivered right after the Shift keydown. The
 * armed guard then suppresses that event, so the committed text never
 * reaches `onData` and the preedit text vanishes (#3441).
 *
 * Same root cause as upstream xtermjs/xterm.js#6054: a modifier keydown
 * never produces text itself, so it must not arm the "a real keydown was
 * already handled" heuristic. Preserve the pre-keydown guard state for
 * modifier-only keydowns (both `key === "Shift"` and legacy keyCode 16/17/
 * 18 shapes) so composed IME commits still arrive through `_inputEvent`.
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import { isModifierOnlyKey } from "./terminalImeTextInput";

/** Classic keyCodes that stand for a modifier-only keydown. */
const MODIFIER_KEY_CODES = new Set([16, 17, 18, 91, 92, 93, 224]);

export function isModifierOnlyKeyDownEvent(event: {
  key: string;
  keyCode?: number;
}): boolean {
  return (
    isModifierOnlyKey(event.key)
    || (event.keyCode !== undefined && MODIFIER_KEY_CODES.has(event.keyCode))
  );
}

type XTermInputCore = {
  _keyDown?: (event: KeyboardEvent) => boolean | undefined;
  _keyDownSeen?: boolean;
};

/**
 * Wrap xterm's keydown entry so a pure modifier keydown cannot arm the
 * `insertText` dedupe guard. Installed per-terminal instance; the prototype
 * method stays untouched.
 */
export function keepImeCommittedTextThroughModifierKeyDowns(term: XTerm): void {
  const core = (term as XTerm & { _core?: XTermInputCore })._core;
  if (!core || typeof core._keyDown !== "function") return;
  const originalKeyDown = core._keyDown.bind(core);
  core._keyDown = (event: KeyboardEvent) => {
    if (!isModifierOnlyKeyDownEvent(event)) return originalKeyDown(event);
    const seenBefore = core._keyDownSeen;
    try {
      return originalKeyDown(event);
    } finally {
      core._keyDownSeen = seenBefore;
    }
  };
}
