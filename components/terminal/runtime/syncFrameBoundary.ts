/**
 * DEC 2026 synchronized-output frame boundaries, for slicing terminal output
 * without tearing a frame.
 *
 * A modern full-screen TUI (Tachikoma, and most others) enters the alternate
 * screen once, then delimits every rendered frame with a DEC private mode 2026
 * synchronized-output block: `\x1b[?2026h` … full frame … `\x1b[?2026l`. xterm
 * buffers rendering while the block is open and paints once on close, so a
 * frame is coherent as long as its whole block reaches xterm before xterm's
 * 1000ms synchronized-output timeout expires (RenderService SyncOutputHandler).
 *
 * The write coalescer/slicer, however, is only aware of alt-screen DECSET
 * toggles — it never sees 2026 — so it slices a continuous frame stream by
 * byte size and hands the shards to xterm across `setTimeout` gaps. A shard
 * boundary that lands inside an open block leaves xterm mid-frame; if the rest
 * of the frame arrives after the 1000ms timeout, xterm force-flushes a partial
 * frame and the display tears.
 *
 * These helpers let the slicer keep every 2026 block whole.
 */

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";

/**
 * Sync-block nesting state at `to`, scanning `data` from `from`.
 *
 * DEC 2026 does not nest in practice (a frame is one open/close pair), so this
 * tracks "open" as a boolean latched by the most recent marker rather than a
 * depth count. Returns whether an open block is still unclosed at `to`.
 */
export function isInsideSyncBlockAt(data: string, from: number, to: number): boolean {
  let open = false;
  let i = data.indexOf("\x1b[?2026", from);
  while (i !== -1 && i < to) {
    if (data.startsWith(SYNC_OPEN, i)) {
      open = true;
      i += SYNC_OPEN.length;
    } else if (data.startsWith(SYNC_CLOSE, i)) {
      open = false;
      i += SYNC_CLOSE.length;
    } else {
      // A different `?2026` sequence (e.g. a DECRQM query `\x1b[?2026$p`) — not
      // a frame boundary; step past this ESC and keep scanning.
      i += 1;
    }
    i = data.indexOf("\x1b[?2026", i);
  }
  return open;
}

/**
 * A slice end at or after `desiredEnd` that never falls strictly inside an open
 * DEC 2026 block.
 *
 * If `desiredEnd` lands inside an open frame, it is pushed forward to just past
 * that frame's `\x1b[?2026l`. If the frame never closes within `data`, the end
 * is pushed to `data.length` so the incomplete frame is held for the next
 * write rather than emitted in pieces.
 *
 * Never moves the end backwards, so it composes with the slicer's other
 * boundary rules (which only ever shrink a slice).
 */
export function frameSafeSliceEnd(
  data: string,
  offset: number,
  desiredEnd: number,
): number {
  if (desiredEnd >= data.length) return data.length;
  if (!isInsideSyncBlockAt(data, offset, desiredEnd)) return desiredEnd;
  const close = data.indexOf(SYNC_CLOSE, desiredEnd);
  if (close === -1) return data.length;
  return close + SYNC_CLOSE.length;
}
