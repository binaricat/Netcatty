import { captureTerminalReflowScrollAnchor } from './terminalHelpers';
import type { TerminalReflowScrollAnchor } from './terminalHelpers';

type Buffer = Parameters<typeof captureTerminalReflowScrollAnchor>[0];

/** Keep the character within the top row across consecutive resize frames. */
export function createTerminalReflowReadingPosition() {
  let previous: {
    buffer: Buffer;
    viewportY: number;
    anchor: TerminalReflowScrollAnchor;
    remainder: number;
  } | null = null;

  return {
    capture(buffer: Buffer, limits: Parameters<typeof captureTerminalReflowScrollAnchor>[1]) {
      const anchor = captureTerminalReflowScrollAnchor(buffer, limits);
      const saved = previous;
      previous = null;
      if (!anchor || anchor.containsCursor) return anchor;
      // A user scroll or changed output establishes a new reading position.
      if (saved?.buffer === buffer && saved.viewportY === buffer.viewportY
        && saved.anchor.startRow === anchor.startRow
        && saved.anchor.charOffset === anchor.charOffset
        && saved.anchor.textPrefix === anchor.textPrefix
        && saved.anchor.viewedText === anchor.viewedText
        && saved.anchor.contextSuffix === anchor.contextSuffix) {
        anchor.charOffset += saved.remainder;
        anchor.viewedText = anchor.viewedText?.slice(saved.remainder);
      }
      return anchor;
    },
    remember(buffer: Buffer, anchor: TerminalReflowScrollAnchor | null) {
      previous = null;
      if (!anchor || anchor.containsCursor) return;
      const current = captureTerminalReflowScrollAnchor(buffer, {
        maxRows: Number.MAX_SAFE_INTEGER, oldCols: 1, newCols: 1,
      });
      // Trim, clamping and failed content resolution must not carry a stale
      // offset into the next frame. Only retain the sub-row rounding loss.
      if (!current || current.containsCursor || current.textPrefix !== anchor.textPrefix
        || current.contextSuffix !== anchor.contextSuffix) return;
      const remainder = anchor.charOffset - current.charOffset;
      const rowLength = buffer.getLine(buffer.viewportY)?.translateToString(false).length ?? 0;
      if (remainder < 0 || remainder >= rowLength) return;
      previous = { buffer, viewportY: buffer.viewportY, anchor: current, remainder };
    },
  };
}
