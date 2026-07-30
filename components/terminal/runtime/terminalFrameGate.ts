/**
 * Frame-rate gate for full-screen animated TUIs.
 *
 * A TUI like TryIt.jl emits every frame as a DEC 2026 synchronized-output block
 * that homes the cursor and repaints every cell:
 *
 *   ESC[?2026h  ESC[1;1H  <every cell rewritten with SGR>  ESC[?2026l
 *
 * At ~60 fps each frame is ~140 KB. xterm.js can render that rate, but only if
 * it is never more than a frame or two behind — otherwise frames queue up and
 * the display (and the keyboard echo waiting behind it) runs up to a second
 * late. The flow-control watermark bounds that backlog by *pausing* the source,
 * which throttles the animation. This gate instead bounds it by *dropping*
 * superseded frames: when a full-repaint frame is buffered behind another, only
 * the last is visible (the next repaints every cell the previous drew), so the
 * earlier one can be skipped. The source is never paused, so the animation keeps
 * its full rate while the backlog — and the latency — stays small.
 *
 * Dropping is deliberately conservative, and proven rather than guessed:
 * - the dropped frame must be a droppable *visual* payload (allowlist of cursor
 *   moves, SGR, erase and cell text — never a bell, device query, OSC, DCS/APC
 *   or private mode whose side effect would be lost); and
 * - its successor must *demonstrably* repaint the whole viewport, measured by
 *   simulating the writes and counting covered cells — not by raw byte length,
 *   which SGR escapes inflate.
 *
 * This module is the pure buffer transform. It has no state and no side
 * effects; the caller owns the per-terminal buffer, the accounting and the
 * fail-open handling for frames that never complete.
 */

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

/** Length of a trailing run of `s` that is a proper (non-empty) prefix of the
 * sync opener — i.e. a `ESC[?2026h` split at a chunk boundary. 0 when none. */
const trailingSyncOpenerPrefixLen = (s: string): number => {
  const max = Math.min(SYNC_ON.length - 1, s.length);
  for (let k = max; k >= 1; k--) {
    if (s.endsWith(SYNC_ON.slice(0, k))) return k;
  }
  return 0;
};

/** True when `s` ends with a split sync opener (a proper prefix of `ESC[?2026h`). */
export const endsWithSyncOpenerPrefix = (s: string): boolean =>
  trailingSyncOpenerPrefixLen(s) > 0;

/** CSI final bytes that only move the cursor, set SGR, or erase. */
const DROPPABLE_CSI_FINALS = new Set([
  "A", "B", "C", "D", "E", "F", "G", "H", "f", // cursor moves / positioning
  "d", "`", // line / column position (VPA / HPA)
  "m", // SGR
  "J", "K", // erase in display / line
  "S", "T", // scroll up / down
]);
/** C0 controls that only move the cursor. */
const DROPPABLE_C0 = new Set(["\r", "\n", "\t", "\b"]);

/**
 * True when every byte of `content` is a cursor move, SGR, erase, or cell text
 * — i.e. dropping the frame loses nothing but pixels a full repaint overwrites.
 * Anything else (BEL, device query/report, OSC, DCS/APC/PM/SOS, a private-mode
 * or alternate-screen toggle, an intermediate-byte CSI) makes the frame
 * un-droppable, since its side effect would never reach xterm.
 */
export const isDroppableVisualPayload = (content: string): boolean => {
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const code = content.charCodeAt(i);
    if (ch === "\x1b") {
      if (content[i + 1] !== "[") return false; // only CSI; reject OSC/DCS/APC/single-char ESC
      let j = i + 2;
      let priv = false;
      let params = "";
      while (j < content.length) {
        const c = content.charCodeAt(j);
        if (c >= 0x30 && c <= 0x3f) {
          if (c === 0x3c || c === 0x3d || c === 0x3e || c === 0x3f) priv = true; // < = > ?
          else params += content[j];
          j++;
        } else {
          break;
        }
      }
      if (j < content.length && content.charCodeAt(j) >= 0x20 && content.charCodeAt(j) <= 0x2f) {
        return false; // intermediate byte — uncommon, treat as un-droppable
      }
      const final = content[j];
      if (final === undefined) return false; // incomplete CSI
      if (priv || !DROPPABLE_CSI_FINALS.has(final)) return false;
      // `CSI 3 J` (ED3) clears the saved scrollback, not just the viewport — a
      // side effect a repaint does not restore, so a frame carrying it is not
      // droppable.
      if (final === "J" && params.split(";").includes("3")) return false;
      i = j + 1;
      continue;
    }
    if (code < 0x20) {
      if (!DROPPABLE_C0.has(ch)) return false; // BEL and other C0 side effects
      i++;
      continue;
    }
    if (code === 0x7f) return false; // DEL
    i++; // printable / UTF-8 byte → cell text
  }
  return true;
};

/**
 * Count the distinct viewport cells `content` writes, by simulating cursor
 * movement, cell output and erases against a `cols`×`rows` grid. Used to prove a
 * frame repaints (nearly) the whole screen before an earlier frame is dropped.
 */
export const viewportRepaintCoverage = (
  content: string,
  cols: number,
  rows: number,
): number => {
  if (cols <= 0 || rows <= 0) return 0;
  const covered = new Set<number>();
  let row = 0;
  let col = 0;
  const clampRow = () => { row = row < 0 ? 0 : row >= rows ? rows - 1 : row; };
  const clampCol = () => { col = col < 0 ? 0 : col >= cols ? cols - 1 : col; };
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < rows && c >= 0 && c < cols) covered.add(r * cols + c);
  };
  const markRange = (r: number, from: number, to: number) => {
    for (let c = Math.max(0, from); c <= to && c < cols; c++) mark(r, c);
  };
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const code = content.charCodeAt(i);
    if (ch === "\x1b" && content[i + 1] === "[") {
      let j = i + 2;
      let params = "";
      while (j < content.length) {
        const c = content.charCodeAt(j);
        if (c >= 0x30 && c <= 0x3f) { params += content[j]; j++; } else break;
      }
      while (j < content.length && content.charCodeAt(j) >= 0x20 && content.charCodeAt(j) <= 0x2f) j++;
      const final = content[j];
      const nums = params.split(";").map((p) => (p === "" ? undefined : parseInt(p, 10)));
      const n0 = nums[0];
      if (final === "H" || final === "f") { row = (n0 ?? 1) - 1; col = (nums[1] ?? 1) - 1; clampRow(); clampCol(); }
      else if (final === "A") { row -= n0 ?? 1; clampRow(); }
      else if (final === "B" || final === "E") { row += n0 ?? 1; clampRow(); }
      else if (final === "C") { col += n0 ?? 1; clampCol(); }
      else if (final === "D") { col -= n0 ?? 1; clampCol(); }
      else if (final === "G" || final === "`") { col = (n0 ?? 1) - 1; clampCol(); }
      else if (final === "d") { row = (n0 ?? 1) - 1; clampRow(); }
      else if (final === "J") {
        const p = n0 ?? 0;
        if (p === 2 || p === 3) { for (let r = 0; r < rows; r++) markRange(r, 0, cols - 1); }
        else if (p === 0) { markRange(row, col, cols - 1); for (let r = row + 1; r < rows; r++) markRange(r, 0, cols - 1); }
        else if (p === 1) { for (let r = 0; r < row; r++) markRange(r, 0, cols - 1); markRange(row, 0, col); }
      } else if (final === "K") {
        const p = n0 ?? 0;
        if (p === 0) markRange(row, col, cols - 1);
        else if (p === 1) markRange(row, 0, col);
        else if (p === 2) markRange(row, 0, cols - 1);
      }
      i = final === undefined ? content.length : j + 1;
      continue;
    }
    if (code < 0x20) {
      if (ch === "\n") { row += 1; clampRow(); }
      else if (ch === "\r") { col = 0; }
      else if (ch === "\b") { col -= 1; clampCol(); }
      else if (ch === "\t") { col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8); }
      i++;
      continue;
    }
    if (code === 0x7f) { i++; continue; }
    mark(row, col);
    col += 1;
    if (col >= cols) { col = 0; row += 1; clampRow(); }
    i++;
  }
  return covered.size;
};

/**
 * Fraction of the viewport a successor must repaint before its predecessor is
 * dropped. Full-screen animated TUIs commonly rewrite only the cells that
 * changed (TryIt.jl repaints ~60% of the grid per frame via cursor jumps), so
 * the bar sits well below 100% to still recognise them, yet far above the few
 * per-cent a small incremental update touches. Dropping is therefore best-effort
 * for animations, not a lossless guarantee — a cell the dropped frame alone
 * repainted shows one frame stale, which is imperceptible in motion.
 */
const FULL_REPAINT_COVERAGE = 0.4;

/** A successor frame that demonstrably repaints (almost) the whole viewport. */
export const makesFullRepaint = (content: string, cols: number, rows: number): boolean => {
  if (cols <= 0 || rows <= 0) return false;
  return viewportRepaintCoverage(content, cols, rows) >= Math.floor(cols * rows * FULL_REPAINT_COVERAGE);
};

type Frame = { start: number; end: number; content: string };

/**
 * Result of {@link collapseAndSplit}:
 * - `complete`  — the leading, collapsed run of complete frames, ready to write.
 * - `partial`   — a trailing, not-yet-closed frame to keep buffering.
 * - `dropped`   — characters removed from `complete` by collapsing.
 */
export type FrameGateSplit = { complete: string; partial: string; dropped: number };

/**
 * Split `buffer` into its complete-frame prefix and a trailing incomplete
 * frame, collapsing runs of superseded full-repaint frames in the prefix down
 * to the last.
 *
 * A frame is dropped only when it is a droppable visual payload AND the frame
 * directly after it, per `isFullRepaint`, demonstrably repaints the whole
 * viewport (so it overwrites everything the dropped frame drew). Everything the
 * transform is unsure about is preserved verbatim.
 */
export const collapseAndSplit = (
  buffer: string,
  isFullRepaint: (content: string) => boolean,
): FrameGateSplit => {
  const frames: Frame[] = [];
  let cursor = 0;
  let partialStart = buffer.length;
  while (true) {
    const on = buffer.indexOf(SYNC_ON, cursor);
    if (on < 0) break;
    const contentStart = on + SYNC_ON.length;
    const off = buffer.indexOf(SYNC_OFF, contentStart);
    if (off < 0) { partialStart = on; break; }
    const end = off + SYNC_OFF.length;
    frames.push({ start: on, end, content: buffer.slice(contentStart, off) });
    cursor = end;
  }

  // Hold back a trailing byte run that is a proper prefix of the sync opener, so
  // an opener split across PTY chunks reunites with the next chunk instead of
  // being forwarded and missed. Only when no unterminated frame already covers
  // the tail.
  if (partialStart === buffer.length) {
    const holdLen = trailingSyncOpenerPrefixLen(buffer);
    if (holdLen > 0) partialStart = buffer.length - holdLen;
  }

  const partial = buffer.slice(partialStart);
  const completeRegion = buffer.slice(0, partialStart);
  if (frames.length < 2) return { complete: completeRegion, partial, dropped: 0 };

  const drop = new Array<boolean>(frames.length).fill(false);
  for (let i = 0; i < frames.length - 1; i++) {
    const cur = frames[i];
    const next = frames[i + 1];
    if (
      next.start === cur.end
      && isDroppableVisualPayload(cur.content)
      && isFullRepaint(next.content)
    ) {
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) return { complete: completeRegion, partial, dropped: 0 };

  let complete = "";
  let dropped = 0;
  let pos = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    complete += completeRegion.slice(pos, f.start);
    if (drop[i]) dropped += f.end - f.start;
    else complete += completeRegion.slice(f.start, f.end);
    pos = f.end;
  }
  complete += completeRegion.slice(pos);
  return { complete, partial, dropped };
};

/** Exact three-way split of buffered ingress bytes; parts always sum to `total`. */
export type FrameGateIngressSplit = { forward: number; dropped: number; held: number };

/**
 * Apportion `total` flow-control ingress bytes across the forwarded, dropped and
 * still-held parts of a buffer, by character share. Each share is the exact
 * complement of the rounded parts before it, so the three always sum back to
 * `total` regardless of rounding — the backend is never over- or
 * under-acknowledged even when a chunk's ingress differs from its length.
 */
export const apportionFrameGateIngress = (
  total: number,
  totalChars: number,
  forwardChars: number,
  droppedChars: number,
  heldChars: number,
): FrameGateIngressSplit => {
  const held = totalChars > 0 ? Math.round((total * heldChars) / totalChars) : 0;
  const leaving = total - held;
  const leavingChars = forwardChars + droppedChars;
  const forward = leavingChars > 0 ? Math.round((leaving * forwardChars) / leavingChars) : 0;
  const dropped = leaving - forward;
  return { forward, dropped, held };
};
