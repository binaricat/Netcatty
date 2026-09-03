"use strict";

// Terminal-originated protocol data travels through xterm's public onData
// event alongside shell-line input. Keep the current xterm report and mouse
// families on the host-owned bypass path so plugins cannot rewrite them and
// shell input tracking does not mistake them for editable text.
function isTerminalReportSequence(data) {
  if (typeof data !== "string" || data.length === 0) return false;
  // Focus in/out reports: ESC [ I  /  ESC [ O
  if (data === "\x1b[I" || data === "\x1b[O") return true;
  // CPR / DECXCPR / DA1 / DA2 / DSR: ESC [ (?|>)? digits/semicolons (R|c|n)
  if (/^\x1b\[[?>]?[0-9;]*[Rcn]$/.test(data)) return true;
  // Kitty keyboard mode query reply: ESC [ ? digits u
  if (/^\x1b\[\?[0-9]+u$/.test(data)) return true;
  // ANSI/DEC mode report (DECRPM): ESC [ (?) mode ; state $ y
  if (/^\x1b\[\??[0-9]+;[0-4]\$y$/.test(data)) return true;
  // Xterm window/cell/character-size reports: ESC [ (4|6|8) ; height ; width t
  if (/^\x1b\[(?:4|6|8);[0-9]+;[0-9]+t$/.test(data)) return true;
  // Mouse tracking reports: classic X10, SGR (1006), and urxvt (1015).
  if (/^\x1b\[M[\s\S]{3}$/.test(data)) return true;
  if (/^\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]$/.test(data)) return true;
  if (/^\x1b\[[0-9]+;[0-9]+;[0-9]+M$/.test(data)) return true;
  // Xterm dynamic-color query replies: OSC (4;index|10|11|12) ; rgb:... (BEL|ST)
  if (/^\x1b\](?:4;[0-9]{1,3}|1[012]);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)$/i.test(data)) return true;
  // OSC 52 clipboard read replies: OSC 52 ; selection ; base64 (BEL|ST)
  if (/^\x1b\]52;[cpsq0-7]*;(?:[a-z0-9+/]*={0,2}|\?)(?:\x07|\x1b\\)$/i.test(data)) return true;
  // DCS replies (XTGETTCAP / DECRQSS, etc.): ESC P ... ESC \
  if (/^\x1bP[\s\S]*\x1b\\$/.test(data)) return true;
  return false;
}

module.exports = { isTerminalReportSequence };
