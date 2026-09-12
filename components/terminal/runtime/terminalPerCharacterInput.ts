/**
 * Strict bastion prompts (e.g. QAX/奇安信) treat one SSH channel write as a
 * single keystroke and silently drop every multi-character chunk (#3077). IME
 * commits and short raw pastes therefore have to leave the renderer as
 * per-character writes, which is what typing produces and what Xshell does.
 */

/** Raw pastes longer than this keep the single-write behavior. */
export const MAX_RAW_PASTE_PER_CHARACTER_LENGTH = 32;

const ESC = "\x1b";

/** True while the payload only carries plain text and no escape sequence. */
export const isPlainTerminalInputText = (data: string): boolean => !data.includes(ESC);

/** One chunk per Unicode code point so surrogate pairs stay intact. */
export const splitTextIntoCodePointWrites = (data: string): string[] => Array.from(data);

/** IME commits: any plain text with more than one character splits per glyph. */
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

/** Chunks to write for one input payload; escape sequences are never split. */
export const getTextInputWireChunks = (
  data: string,
  perCharacterWrites: boolean,
): string[] =>
  perCharacterWrites && isPlainTerminalInputText(data)
    ? splitTextIntoCodePointWrites(data)
    : [data];