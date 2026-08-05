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
const SYNC_ON_C1 = "\x9b?2026h";
const SYNC_OFF_C1 = "\x9b?2026l";

/** Length of a trailing run of `s` that is a proper (non-empty) prefix of the
 * sync opener — 7-bit ESC CSI or 8-bit C1 CSI form. 0 when none. */
const trailingSyncOpenerPrefixLen = (s: string): number => {
  let best = 0;
  for (const opener of [SYNC_ON, SYNC_ON_C1]) {
    const max = Math.min(opener.length - 1, s.length);
    for (let k = max; k >= 1; k--) {
      if (s.endsWith(opener.slice(0, k))) {
        best = Math.max(best, k);
        break;
      }
    }
  }
  return best;
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
  // SU/SD (S/T) intentionally omitted: they scroll the buffer/region and can
  // mutate history; a later full repaint restores cells but not lost scroll
  // (Codex P2 on d2e6999e).
]);
/**
 * C0 controls that only move the cursor without mutating scrollback.
 * LF (`\n`) is intentionally excluded: on the normal buffer with the cursor on
 * the bottom row, xterm scrolls and can add a history line. Dropping such a
 * frame before xterm sees it loses scrollback that a later full repaint cannot
 * restore (while the backend has already been acked).
 */
const DROPPABLE_C0 = new Set(["\r", "\t", "\b"]);

/**
 * True when `content` contains at least one CSI SGR (`…m`) sequence.
 * Used so a frame that only changes rendition is not dropped unless its
 * successor also re-establishes SGR (otherwise xterm keeps pre-drop colors).
 */
export const payloadContainsSgr = (content: string): boolean => {
  let i = 0;
  while (i < content.length) {
    if (content[i] === "\x1b" && content[i + 1] === "[") {
      let j = i + 2;
      while (j < content.length) {
        const c = content.charCodeAt(j);
        if (c >= 0x30 && c <= 0x3f) {
          j++;
          continue;
        }
        if (c >= 0x20 && c <= 0x2f) {
          j++;
          continue;
        }
        if (content[j] === "m") return true;
        i = j + 1;
        break;
      }
      if (j >= content.length) return false;
      continue;
    }
    i++;
  }
  return false;
};

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
    // 8-bit C1 controls (0x80–0x9F): CSI (0x9B), OSC (0x9D), DCS (0x90), …
    // xterm accepts these as equivalents of the ESC-prefixed forms. Treat any
    // C1 as un-droppable so title/mode/cursor side effects are never skipped
    // when a frame is collapsed (C1 bytes would otherwise fall through as
    // printable cell text).
    if (code >= 0x80 && code <= 0x9f) return false;
    i++; // printable / Unicode cell text
  }
  return true;
};

/**
 * Count the distinct viewport cells `content` writes, by simulating cursor
 * movement, cell output and erases against a `cols`×`rows` grid. Used to prove a
 * frame repaints (nearly) the whole screen before an earlier frame is dropped.
 */
/**
 * True when writing `content` from the default (0,0) cursor can trigger xterm
 * delayed autowrap into a scroll (past the bottom-right cell). Such frames must
 * not be dropped: the successor full-repaint restores cells but not scrollback
 * history lines created by the wrap (Codex P2).
 */
export const payloadMayAutowrapScroll = (
  content: string,
  cols: number,
  rows: number,
): boolean => {
  if (cols <= 0 || rows <= 0) return true;
  let row = 0;
  let col = 0;
  let wrapPending = false;
  const applyCsi = (paramStart: number): number => {
    let j = paramStart;
    let params = "";
    while (j < content.length) {
      const c = content.charCodeAt(j);
      if (c >= 0x30 && c <= 0x3f) { params += content[j]; j++; } else break;
    }
    while (j < content.length && content.charCodeAt(j) >= 0x20 && content.charCodeAt(j) <= 0x2f) j++;
    const final = content[j];
    const nums = params.split(";").map((p) => (p === "" ? undefined : parseInt(p, 10)));
    const n0 = nums[0];
    if (final === "H" || final === "f") {
      row = Math.max(0, Math.min(rows - 1, (n0 ?? 1) - 1));
      col = Math.max(0, Math.min(cols - 1, (nums[1] ?? 1) - 1));
      wrapPending = false;
    } else if (final === "A") { row = Math.max(0, row - (n0 ?? 1)); wrapPending = false; }
    else if (final === "B" || final === "E") { row = Math.min(rows - 1, row + (n0 ?? 1)); wrapPending = false; }
    else if (final === "C") { col = Math.min(cols - 1, col + (n0 ?? 1)); wrapPending = false; }
    else if (final === "D") { col = Math.max(0, col - (n0 ?? 1)); wrapPending = false; }
    else if (final === "G" || final === "`") { col = Math.max(0, Math.min(cols - 1, (n0 ?? 1) - 1)); wrapPending = false; }
    else if (final === "d") { row = Math.max(0, Math.min(rows - 1, (n0 ?? 1) - 1)); wrapPending = false; }
    return final === undefined ? content.length : j + 1;
  };
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const code = content.charCodeAt(i);
    if (ch === "\x1b") {
      if (content[i + 1] === "[") {
        i = applyCsi(i + 2);
        continue;
      }
      i += content[i + 1] === undefined ? 1 : 2;
      continue;
    }
    if (code === 0x9b) {
      i = applyCsi(i + 1);
      continue;
    }
    if (code < 0x20) {
      if (ch === "\n") {
        wrapPending = false;
        row += 1;
        if (row >= rows) return true;
        col = 0;
      } else if (ch === "\r") {
        col = 0;
        wrapPending = false;
      } else if (ch === "\b") {
        col = Math.max(0, col - 1);
        wrapPending = false;
      } else if (ch === "\t") {
        col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
        wrapPending = false;
      }
      i++;
      continue;
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      i++;
      continue;
    }
    if (wrapPending) {
      wrapPending = false;
      col = 0;
      row += 1;
      if (row >= rows) return true;
    }
    if (col >= cols - 1) {
      wrapPending = true;
      col = cols - 1;
    } else {
      col += 1;
    }
    i++;
  }
  return false;
};

export const viewportRepaintCoverage = (
  content: string,
  cols: number,
  rows: number,
): number => {
  if (cols <= 0 || rows <= 0) return 0;
  const covered = new Set<number>();
  let row = 0;
  let col = 0;
  // Only count cells painted after an explicit origin reset (CUP/home). A late
  // CSI H at the end of a frame must not retroactively validate paints from
  // the simulated (0,0) start. ED2 alone is not an origin (Codex P2).
  let originKnown = false;
  const clampRow = () => { row = row < 0 ? 0 : row >= rows ? rows - 1 : row; };
  const clampCol = () => { col = col < 0 ? 0 : col >= cols ? cols - 1 : col; };
  const mark = (r: number, c: number) => {
    if (!originKnown) return;
    if (r >= 0 && r < rows && c >= 0 && c < cols) covered.add(r * cols + c);
  };
  const markRange = (r: number, from: number, to: number) => {
    for (let c = Math.max(0, from); c <= to && c < cols; c++) mark(r, c);
  };
  /** Advance past a control-string payload terminated by BEL, ST (ESC \), or C1 ST. */
  const skipControlString = (from: number): number => {
    let j = from;
    while (j < content.length) {
      const c = content.charCodeAt(j);
      if (c === 0x07) return j + 1; // BEL
      if (c === 0x9c) return j + 1; // C1 ST
      if (content[j] === "\x1b" && content[j + 1] === "\\") return j + 2; // ESC \
      j++;
    }
    return content.length; // incomplete — consume remainder, never count as cells
  };
  /** Apply CSI cursor/erase effects starting at the first parameter byte. */
  const applyCsi = (paramStart: number): number => {
    let j = paramStart;
    let params = "";
    while (j < content.length) {
      const c = content.charCodeAt(j);
      if (c >= 0x30 && c <= 0x3f) { params += content[j]; j++; } else break;
    }
    while (j < content.length && content.charCodeAt(j) >= 0x20 && content.charCodeAt(j) <= 0x2f) j++;
    const final = content[j];
    const nums = params.split(";").map((p) => (p === "" ? undefined : parseInt(p, 10)));
    const n0 = nums[0];
    if (final === "H" || final === "f") {
      row = (n0 ?? 1) - 1;
      col = (nums[1] ?? 1) - 1;
      clampRow();
      clampCol();
      // CUP establishes a known origin for subsequent paints only.
      originKnown = true;
    } else if (final === "A") { row -= n0 ?? 1; clampRow(); }
    else if (final === "B" || final === "E") { row += n0 ?? 1; clampRow(); }
    else if (final === "C") { col += n0 ?? 1; clampCol(); }
    else if (final === "D") { col -= n0 ?? 1; clampCol(); }
    else if (final === "G" || final === "`") { col = (n0 ?? 1) - 1; clampCol(); }
    else if (final === "d") { row = (n0 ?? 1) - 1; clampRow(); }
    else if (final === "J") {
      const p = n0 ?? 0;
      // ED2 clears the display but does NOT move the cursor (xterm). Do not
      // treat it as a known origin — only CUP/home does. ED2 also grants no
      // coverage credit (scrolled-up filter may strip it later) (Codex P2).
      if (p === 2) { /* no originKnown; no coverage */ }
      // ED0/ED1 still mark the cells they clear (not stripped by that filter).
      else if (p === 0) { markRange(row, col, cols - 1); for (let r = row + 1; r < rows; r++) markRange(r, 0, cols - 1); }
      else if (p === 1) { for (let r = 0; r < row; r++) markRange(r, 0, cols - 1); markRange(row, 0, col); }
    } else if (final === "K") {
      const p = n0 ?? 0;
      if (p === 0) markRange(row, col, cols - 1);
      else if (p === 1) markRange(row, 0, col);
      else if (p === 2) markRange(row, 0, cols - 1);
    }
    return final === undefined ? content.length : j + 1;
  };
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const code = content.charCodeAt(i);
    if (ch === "\x1b") {
      const intro = content[i + 1];
      if (intro === "[") {
        // CSI: parse cursor/erase; do not count parameter bytes as cell paints.
        i = applyCsi(i + 2);
        continue;
      }
      // OSC / DCS / SOS / PM / APC control strings — payloads run until ST or BEL.
      // Counting their bytes as cell paints falsely inflates repaint coverage.
      if (intro === "]" || intro === "P" || intro === "X" || intro === "^" || intro === "_") {
        i = skipControlString(i + 2);
        continue;
      }
      // Other ESC sequences (e.g. ESC 7, ESC (B): skip introducer + body; never
      // mark intermediate/final bytes as viewport cells.
      if (intro !== undefined) {
        let j = i + 1;
        while (j < content.length && content.charCodeAt(j) >= 0x20 && content.charCodeAt(j) <= 0x2f) j++;
        if (j < content.length && content.charCodeAt(j) >= 0x30 && content.charCodeAt(j) <= 0x7e) {
          i = j + 1;
        } else {
          i = content.length;
        }
        continue;
      }
      i++;
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
    // 8-bit C1: CSI (0x9B) and control-string introducers — never cell paints.
    if (code === 0x9b) {
      i = applyCsi(i + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      i = skipControlString(i + 1);
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) { i++; continue; }
    mark(row, col);
    col += 1;
    if (col >= cols) { col = 0; row += 1; clampRow(); }
    i++;
  }
  return covered.size;
};

/**
 * Fraction of the viewport a successor must repaint before its predecessor is
 * dropped. Require near-full coverage so incremental successors (HOME + a few
 * cells, or SGR-heavy partial paints) never justify dropping a prior frame.
 *
 * Historical note: a 0.4 threshold accepted ~40% paints and dropped prior
 * frames with untouched cells still showing stale content. 0.99 keeps only a
 * single-cell wrap/clamp off-by-one margin while still demanding essentially
 * complete cell overwrite (or an ED2 clear).
 */
const FULL_REPAINT_COVERAGE = 0.99;

/**
 * True when the frame establishes a known cursor origin via CUP/home.
 * ED2 clears the display but does not home the cursor in xterm, so it is not
 * a known origin by itself (Codex P2).
 */
export const hasKnownCursorOrigin = (content: string): boolean => {
  if (
    content.includes("\x1b[H")
    || content.includes("\x1b[f")
    || content.includes("\x1b[1;1H")
    || content.includes("\x1b[1;1f")
    || content.includes("\x1b[;1H")
    || content.includes("\x9bH")
    || content.includes("\x9bf")
    || content.includes("\x9b1;1H")
    || content.includes("\x9b1;1f")
  ) {
    return true;
  }
  return false;
};

/** A successor frame that demonstrably repaints (almost) the whole viewport. */
export const makesFullRepaint = (content: string, cols: number, rows: number): boolean => {
  if (cols <= 0 || rows <= 0) return false;
  // Coverage only counts cells after an in-order CUP/home origin reset.
  const total = cols * rows;
  const covered = viewportRepaintCoverage(content, cols, rows);
  // Exact full coverage, or near-full (>= 99%) so tiny clamp/wrap off-by-ones
  // do not block legitimate full repaints while partial paints still fail.
  if (covered >= total) return true;
  return covered >= Math.ceil(total * FULL_REPAINT_COVERAGE);
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
  viewport?: { cols: number; rows: number },
): FrameGateSplit => {
  const frames: Frame[] = [];
  let cursor = 0;
  let partialStart = buffer.length;
  const nextOpen = (from: number): { at: number; len: number } | null => {
    const a = buffer.indexOf(SYNC_ON, from);
    const b = buffer.indexOf(SYNC_ON_C1, from);
    if (a < 0 && b < 0) return null;
    if (a < 0) return { at: b, len: SYNC_ON_C1.length };
    if (b < 0) return { at: a, len: SYNC_ON.length };
    return a <= b ? { at: a, len: SYNC_ON.length } : { at: b, len: SYNC_ON_C1.length };
  };
  const nextClose = (from: number): { at: number; len: number } | null => {
    const a = buffer.indexOf(SYNC_OFF, from);
    const b = buffer.indexOf(SYNC_OFF_C1, from);
    if (a < 0 && b < 0) return null;
    if (a < 0) return { at: b, len: SYNC_OFF_C1.length };
    if (b < 0) return { at: a, len: SYNC_OFF.length };
    return a <= b ? { at: a, len: SYNC_OFF.length } : { at: b, len: SYNC_OFF_C1.length };
  };
  while (true) {
    const open = nextOpen(cursor);
    if (!open) break;
    const contentStart = open.at + open.len;
    const close = nextClose(contentStart);
    if (!close) { partialStart = open.at; break; }
    const end = close.at + close.len;
    frames.push({ start: open.at, end, content: buffer.slice(contentStart, close.at) });
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
    // If the dropped frame carried SGR, the successor must re-establish
    // rendition state (any CSI … m). Otherwise xterm keeps pre-drop colors
    // when the successor omits redundant SGR (Codex P2 on dd606f39).
    if (
      next.start === cur.end
      && isDroppableVisualPayload(cur.content)
      && isFullRepaint(next.content)
      && (!payloadContainsSgr(cur.content) || payloadContainsSgr(next.content))
      // Reject predecessors that can autowrap-scroll (Codex P2).
      && !(
        viewport
        && payloadMayAutowrapScroll(cur.content, viewport.cols, viewport.rows)
      )
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
