/**
 * CJK IMEs (notably Sogou on macOS) often emit a keydown whose `event.key` is
 * still the half-width ASCII punctuation, then commit the full-width glyph via
 * an `input`/`insertText` event. xterm.js sends the keydown character and then
 * drops the input event because `_keyDownSeen` is set — so the PTY receives
 * "," instead of "，".
 *
 * Defer those keydowns to the following insertText. If no remap arrives before
 * keyup/blur, the original ASCII key is flushed. Composition (keyCode 229 /
 * isComposing) stays on xterm's CompositionHelper path.
 */

export type ImeTextInputKeyEvent = {
  type?: string;
  key: string;
  keyCode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
};

export type ImeTextInputEvent = Pick<InputEvent, "data" | "inputType">;

/** Printable ASCII punctuation IMEs commonly remap to full-width forms. */
const ASCII_PUNCTUATION_RE = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/;

export function isAsciiPunctuationKey(key: string): boolean {
  return ASCII_PUNCTUATION_RE.test(key);
}

export function shouldDeferKeyDownForImeTextInput(
  event: ImeTextInputKeyEvent,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") return false;
  if (event.isComposing === true || event.keyCode === 229) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return isAsciiPunctuationKey(event.key);
}

export function shouldBlockKeyPressForImeTextInput(
  deferredKey: string | null | undefined,
  event: Pick<ImeTextInputKeyEvent, "type">,
): boolean {
  return Boolean(deferredKey) && event.type === "keypress";
}

export function shouldCommitDeferredImeTextInput(
  deferredKey: string | null | undefined,
  event: ImeTextInputEvent,
): event is ImeTextInputEvent & { data: string } {
  return (
    Boolean(deferredKey) &&
    event.inputType === "insertText" &&
    typeof event.data === "string" &&
    event.data.length > 0
  );
}

/**
 * True when insertText/flush kept the deferred ASCII key (no CJK remap).
 * Those commits must not use Kitty composition encoding — under report-all
 * that emits unidentified CSI 0 u and drops press/release.
 */
export function isUnchangedDeferredImeTextInput(
  deferredKey: string | null | undefined,
  text: string,
): boolean {
  return deferredKey != null && text === deferredKey;
}
