/**
 * Legacy workaround introduced by #3168 after #3077 reported that individual
 * hanzi worked where multi-character input did not. The remote parser and
 * other terminals' default send behavior were not verified. SSH sessions now
 * select this workaround in their host settings.
 */

/** Raw pastes longer than this keep the single-write behavior. */
export const MAX_RAW_PASTE_PER_CHARACTER_LENGTH = 32;

// Terminal control bytes are intentional: never fragment shortcuts or reports.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const ESC = "\x1b";

/** True while the payload only carries plain text and no escape sequence. */
export const isPlainTerminalInputText = (data: string): boolean => !data.includes(ESC);

/** One chunk per Unicode code point so surrogate pairs stay intact. */
export const splitTextIntoCodePointWrites = (data: string): string[] => Array.from(data);

/** IME commits: any plain text with more than one character splits per code point. */
export const shouldSplitImeTextInputForWire = (text: string): boolean =>
  Array.from(text).length > 1 && isPlainTerminalInputText(text);

/**
 * Raw (non-bracketed) paste: short plain text goes out as keystrokes, longer
 * pastes keep the single write so bulk pastes do not degrade.
 */
export const shouldSplitRawPasteInputForWire = (data: string): boolean => {
  if (data.length <= 1 || !isPlainTerminalInputText(data)) return false;
  let codePoints = 0;
  for (let index = 0; index < data.length; ) {
    index += (data.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    codePoints += 1;
    if (codePoints > MAX_RAW_PASTE_PER_CHARACTER_LENGTH) return false;
  }
  return true;
};

/** Escape sequences never split. SSH callers also preserve terminal controls. */
export const getTextInputWireChunks = (
  data: string,
  perCharacterWrites: boolean,
  preserveTerminalControls = false,
): string[] =>
  perCharacterWrites && isPlainTerminalInputText(data)
    && !(preserveTerminalControls && TERMINAL_CONTROL.test(data))
    ? splitTextIntoCodePointWrites(data)
    : [data];