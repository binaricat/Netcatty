import assert from "node:assert/strict";
import test from "node:test";

import { createRequire } from "node:module";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as XTermType } from "@xterm/xterm";

import { writeTerminalDataWithLineTimestamps } from "./runtime/terminalLineTimestamps.ts";
import {
  noteTerminalOutputPressureData,
  setTerminalOutputPressureVisibility,
} from "./runtime/terminalOutputPressure.ts";
import { writeTerminalPayloadChunked } from "./terminalReplay.ts";
import { KeywordHighlighter } from "./keywordHighlight.ts";

const require = createRequire(import.meta.url);
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: typeof SerializeAddonType;
};
const { Terminal: XTerm } = require("@xterm/xterm") as {
  Terminal: typeof XTermType;
};

const RED = 0xf87171;
const BLUE = 0x60a5fa;

const rule = (color = "#F87171") => [{
  id: "error",
  label: "Error",
  patterns: ["ERROR"],
  color,
  enabled: true,
}];

const write = (term: XTermType, data: string): Promise<void> => new Promise((resolve) => {
  term.write(data, resolve);
});

const cellRgb = (term: XTermType, y: number, text: string): number | undefined => {
  const line = term.buffer.active.getLine(y);
  const raw = line?.translateToString(true) ?? "";
  const index = raw.indexOf(text);
  if (index < 0) return undefined;
  return line?.getCell(index)?.getFgColor();
};

const uncoloredKeywordLines = (term: XTermType, text: string, rgb: number): number[] => {
  const missed: number[] = [];
  for (let y = 0; y < term.buffer.active.length; y += 1) {
    const line = term.buffer.active.getLine(y);
    const raw = line?.translateToString(true) ?? "";
    const index = raw.indexOf(text);
    if (index < 0) continue;
    if (line?.getCell(index)?.getFgColor() !== rgb) missed.push(y);
  }
  return missed;
};

const firstRgbMatch = (term: XTermType, rgb: number): number => {
  let count = 0;
  for (let y = 0; y < term.buffer.active.length; y += 1) {
    const line = term.buffer.active.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      if (line.getCell(x)?.getFgColor() === rgb) count += 1;
    }
  }
  return count;
};

test("new output is colored on the written cells without decorations", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "plain ERROR text");

  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  assert.equal(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor(), -1);

  highlighter.dispose();
  term.dispose();
});

test("ordinary Enter output does not revisit existing history", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "existing ERROR");
  await highlighter.whenSettled();
  const rebuildsBefore = highlighter.rebuildCount;
  const before = cellRgb(term, 0, "ERROR");

  await write(term, "\r\nplain prompt # ");

  assert.equal(cellRgb(term, 0, "ERROR"), before);
  assert.equal(highlighter.rebuildCount, rebuildsBefore);
  highlighter.dispose();
  term.dispose();
});

test("changing or disabling rules recolors existing history from original cell colors", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);

  highlighter.setRules(rule(), true);
  await write(term, "first ERROR\r\nsecond ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  assert.match(visibleSerializer.serialize(), /38;2;248;113;113m/);
  assert.equal(
    highlighter.serializeAddon.serialize(),
    "first ERROR\r\nsecond ERROR",
    "saved history must never contain Netcatty's injected colors",
  );
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(cellRgb(term, 0, "ERROR"), BLUE);
  assert.equal(cellRgb(term, 1, "ERROR"), BLUE);
  assert.match(visibleSerializer.serialize(), /38;2;96;165;250m/);
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);

  highlighter.setRules(rule("#60A5FA"), false);
  await highlighter.whenSettled();
  assert.equal(visibleSerializer.serialize(), "first ERROR\r\nsecond ERROR");

  highlighter.dispose();
  term.dispose();
});

test("keywords split across ordinary writes are colored after the line is complete", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "plain ERR");
  assert.notEqual(cellRgb(term, 0, "ERR"), RED);
  await write(term, "OR text");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("overlapping expressions color each character at most once", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "overlap",
    label: "Overlap",
    patterns: ["\\[ERROR\\]", "ERROR"],
    color: "#F87171",
    enabled: true,
  }], true);
  await write(term, "[ERROR]");
  assert.equal(firstRgbMatch(term, RED), 7);
  highlighter.dispose();
  term.dispose();
});

test("line anchors are evaluated per output line", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "prompt",
    label: "Prompt",
    patterns: ["^#"],
    color: "#F87171",
    enabled: true,
  }], true);
  await write(term, "# one\r\n# two");
  assert.equal(cellRgb(term, 0, "#"), RED);
  assert.equal(cellRgb(term, 1, "#"), RED);
  highlighter.dispose();
  term.dispose();
});

test("alternate-screen programs are not keyword-colored", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "before ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  await write(term, "\x1b[?1049hTUI ERROR");
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED);
  await write(term, "\x1b[?1049l");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("byte output catches up once instead of staying permanently uncolored", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await new Promise<void>((resolve) => {
    term.write(new TextEncoder().encode("byte ERROR"), resolve);
  });
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("large output can bypass per-write coloring and is still recolored on a rule change", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, `${"ERROR ".repeat(20)}tail`);
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED);

  bypass = false;
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(cellRgb(term, 0, "ERROR"), BLUE);

  highlighter.dispose();
  term.dispose();
});

test("bulk output skipped on the hot path is highlighted after output becomes quiet", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 8, scrollback: 100 });
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  const history = Array.from({ length: 40 }, (_, index) => `line-${index} ERROR`).join("\r\n");
  await write(term, history);
  assert.equal(highlighter.rebuildCount, 0, "hot-path flood must not recolor immediately");
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED);
  bypass = false;

  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("streaming bulk output colors the viewport in the same write", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  // More than BULK_WRITE_LINE_BREAKS newlines per chunk, but far below the
  // large-output rate, like a coalesced `tail -f` tick (#3271).
  const chunk = Array.from({ length: 12 }, (_, index) => `line-${index} ERROR`).join("\r\n");
  await write(term, chunk);
  assert.equal(highlighter.rebuildCount, 0);
  const viewportY = term.buffer.active.viewportY;
  assert.equal(cellRgb(term, viewportY + 4, "ERROR"), RED, "visible rows must color in-frame");
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED, "history above the viewport stays with catch-up");

  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("ordinary Enter does not rebuild a saturated scrollback", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 40, rows: 3, scrollback: 10 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const history = Array.from({ length: 20 }, (_, index) => `line-${index} ERROR`).join("\r\n");
  noteTerminalOutputPressureData(term, history);
  await write(term, history);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  const rebuildsBeforeEnter = highlighter.rebuildCount;

  const prompt = "\r\nplain prompt # ";
  noteTerminalOutputPressureData(term, prompt);
  await write(term, prompt);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.equal(highlighter.rebuildCount, rebuildsBeforeEnter);
  highlighter.dispose();
  term.dispose();
});

test("Enter fused with bracketed-paste CR keeps the previous line highlighted", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "[root@host ~]# echo ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  // bash 5.1+ disables bracketed paste on Enter with `\x1b[?2004l\r`; the bare
  // CR arrives fused with the echoed newline, output, and next prompt.
  await write(term, "\r\n\x1b[?2004l\rERROR\r\n\x1b[?2004h[root@host ~]# ");

  assert.equal(cellRgb(term, 1, "ERROR"), RED, "new output must be highlighted");
  assert.equal(cellRgb(term, 0, "ERROR"), RED, "previous command line must stay highlighted");
  highlighter.dispose();
  term.dispose();
});

test("newline-prefixed chunks that climb back up do not leave stale highlight colors", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  // Multi-line progress style redraw: advance, climb back up, partially
  // overwrite the highlighted keyword, and return to the newer row.
  await write(term, "\r\n\x1b[1A\rOK\x1b[1B");

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "OKROR");
  const line = term.buffer.active.getLine(0);
  for (let x = 0; x < 5; x += 1) {
    assert.notEqual(line?.getCell(x)?.getFgColor(), RED, `cell ${x} must not keep the injected color`);
  }
  highlighter.dispose();
  term.dispose();
});

test("VPA jumps back to an earlier row without leaving stale highlight colors", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  // Absolute vertical positioning (CSI Ps d) can also target the earlier row.
  await write(term, "\r\n\x1b[1d\rOK\x1b[2d");

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "OKROR");
  const line = term.buffer.active.getLine(0);
  for (let x = 0; x < 5; x += 1) {
    assert.notEqual(line?.getCell(x)?.getFgColor(), RED, `cell ${x} must not keep the injected color`);
  }
  highlighter.dispose();
  term.dispose();
});

test("DECSTBM homing does not leave stale highlight colors on the earlier row", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  // Setting a scroll region (CSI Ps;Ps r) homes the cursor back to row 0.
  await write(term, "\r\n\x1b[1;10r\rOK\x1b[1B");

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "OKROR");
  const line = term.buffer.active.getLine(0);
  for (let x = 0; x < 5; x += 1) {
    assert.notEqual(line?.getCell(x)?.getFgColor(), RED, `cell ${x} must not keep the injected color`);
  }
  highlighter.dispose();
  term.dispose();
});

test("unenumerated homing controls are caught by the start-row fingerprint", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 10, scrollback: 50 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);

  // DECOM (CSI ?6h) homes the cursor but is not in the backtracking regex;
  // the mutated start row is detected by its changed text instead.
  await write(term, "\r\n\x1b[?6h\rOK\x1b[1B");

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "OKROR");
  const line = term.buffer.active.getLine(0);
  for (let x = 0; x < 5; x += 1) {
    assert.notEqual(line?.getCell(x)?.getFgColor(), RED, `cell ${x} must not keep the injected color`);
  }
  highlighter.dispose();
  term.dispose();
});

test("carriage-return rewrites rematch the current line", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "plain ERROR");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  await write(term, "\rready OK   ");
  assert.equal(cellRgb(term, 0, "ERROR"), undefined);
  assert.match(term.buffer.active.getLine(0)?.translateToString(true) ?? "", /ready OK/);
  highlighter.dispose();
  term.dispose();
});

test("rule changes keep scrollback position", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 40 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 20 }, (_, index) => `line-${index} ERROR`).join("\r\n"));
  term.scrollToLine(2);
  const viewportY = term.buffer.active.viewportY;

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(term.buffer.active.viewportY, viewportY);
  highlighter.dispose();
  term.dispose();
});

test("rule changes preserve existing line timestamps", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(term, "stamp ERROR\r\nnext ERROR", resolve, {
      timestampDate: new Date("2026-08-13T00:00:00.000Z"),
    });
  });
  const markersBefore = term.markers.length;

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(term.markers.length, markersBefore);
  assert.equal(cellRgb(term, 0, "ERROR"), BLUE);
  highlighter.dispose();
  term.dispose();
});

test("same-line appends still restore original colors when rules are disabled", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR");
  await write(term, " more");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  highlighter.setRules(rule(), false);
  await highlighter.whenSettled();
  assert.notEqual(cellRgb(term, 0, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("clear recolors the retained cursor row when rules stay enabled", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "keep ERROR");
  term.clear();
  const line = term.buffer.active.getLine(0)?.translateToString(true) ?? "";
  if (line.includes("ERROR")) {
    assert.equal(cellRgb(term, 0, "ERROR"), RED);
  }
  highlighter.dispose();
  term.dispose();
});

test("clear restores highlighted retained cells before dropping originals", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "ERROR stays");
  term.clear();
  highlighter.setRules(rule(), false);
  await highlighter.whenSettled();
  const line = term.buffer.active.getLine(0)?.translateToString(true) ?? "";
  if (line.includes("ERROR")) {
    assert.notEqual(cellRgb(term, 0, "ERROR"), RED);
  }
  highlighter.dispose();
  term.dispose();
});

test("application reset clears highlight state with the visible terminal", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");
  term.reset();
  await write(term, "new plain");
  assert.equal(highlighter.serializeAddon.serialize(), "new plain");
  highlighter.dispose();
  term.dispose();
});

test("8-digit plugin hex colors keep RGB and ignore alpha", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "plugin-alpha",
    label: "Error",
    patterns: ["ERROR"],
    color: "#F8717180",
    enabled: true,
    providerId: "plugin.demo",
  }], true);
  await write(term, "plain ERROR text");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("plugin scans stay within the bounded match budget", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "plugin-dots",
    label: "Dots",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
    providerId: "plugin.demo",
  }], true);
  await write(term, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  assert.ok(firstRgbMatch(term, RED) <= 256);
  highlighter.dispose();
  term.dispose();
});

test("Enter does not refresh already highlighted history rows", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "existing ERROR");
  const refreshed: Array<[number, number]> = [];
  const originalRefresh = term.refresh.bind(term);
  term.refresh = (start, end) => {
    refreshed.push([start, end]);
    originalRefresh(start, end);
  };
  await write(term, "\r\nplain prompt # ");
  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  assert.ok(refreshed.every(([start]) => start >= 1), JSON.stringify(refreshed));
  highlighter.dispose();
  term.dispose();
});

test("a keyword written on a saturated scrollback is still colored", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 20, rows: 3, scrollback: 2 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 8 }, (_, index) => `pad-${index}`).join("\r\n"));
  await write(term, "\r\nline ERROR");
  assert.equal(cellRgb(term, term.buffer.active.baseY + term.buffer.active.cursorY, "ERROR")
    ?? cellRgb(term, term.buffer.active.length - 1, "ERROR")
    ?? cellRgb(term, term.buffer.active.length - 2, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("Mosh-style full-screen cursor-addressed repaint keeps highlights", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 4, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "row-1 ERROR\r\nrow-2 ERROR\r\nrow-3 ERROR\r\nrow-4 ERROR");
  assert.deepEqual(
    Array.from({ length: 4 }, (_, y) => cellRgb(term, y, "ERROR")),
    [RED, RED, RED, RED],
  );

  // Mosh redraws a numbered remote framebuffer with absolute cursor moves.
  // Once the remote screen fills, an Enter can repaint rows above the local
  // cursor without emitting newlines or leaving the primary buffer.
  await write(
    term,
    "\x1b[1;1Hrow-2 ERROR\x1b[2;1Hrow-3 ERROR"
      + "\x1b[3;1Hrow-4 ERROR\x1b[4;1Hprompt ERROR",
  );

  assert.deepEqual(
    Array.from({ length: 4 }, (_, y) => cellRgb(term, y, "ERROR")),
    [RED, RED, RED, RED],
  );

  // PTY chunking can split a cursor-addressing sequence at any byte.
  await write(term, "\x1b[1;");
  await write(
    term,
    "1Hsplit ERROR\x1b[2;1Hrow-4 ERROR"
      + "\x1b[3;1Hprompt ERROR\x1b[4;1Hdone ER",
  );
  await write(term, "ROR\x1b[1;1H");
  assert.deepEqual(
    Array.from({ length: 4 }, (_, y) => cellRgb(term, y, "ERROR")),
    [RED, RED, RED, RED],
  );
  highlighter.dispose();
  term.dispose();
});

test("Mosh repaint highlights survive every transport split point", async () => {
  const frame = "\x1b[1;1Hnew-1 ERROR\x1b[2;1Hnew-2 ERROR"
    + "\x1b[3;1Hnew-3 ERROR\x1b[4;1Hnew-4 ERROR\x1b[1;1H";
  for (let split = 1; split < frame.length; split += 1) {
    const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 4, scrollback: 20 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, "old-1 ERROR\r\nold-2 ERROR\r\nold-3 ERROR\r\nold-4 ERROR");
    await write(term, frame.slice(0, split));
    await write(term, frame.slice(split));
    assert.deepEqual(
      Array.from({ length: 4 }, (_, y) => cellRgb(term, y, "ERROR")),
      [RED, RED, RED, RED],
      `split ${split}`,
    );
    highlighter.dispose();
    term.dispose();
  }
});

test("cursor-addressed repaint follows CRLF rows before restoring the cursor", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 4, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4");
  await write(term, "\x1b[1;1Hnew-1 ERROR\r\nnew-2 ERROR\r\nnew-3 ERROR\x1b[1;1H");

  assert.deepEqual(
    Array.from({ length: 3 }, (_, y) => cellRgb(term, y, "ERROR")),
    [RED, RED, RED],
  );
  highlighter.dispose();
  term.dispose();
});

test("cursor-addressed repaint keeps pre-scroll rows highlighted", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 4, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4");
  await write(
    term,
    "\x1b[1;1Hscrolled ERROR\r\nline-2\r\nline-3\r\nline-4\r\nline-5\x1b[1;1H",
  );

  const highlightedRows: number[] = [];
  for (let y = 0; y < term.buffer.active.length; y += 1) {
    if (cellRgb(term, y, "ERROR") === RED) highlightedRows.push(y);
  }
  assert.deepEqual(highlightedRows, [0]);
  highlighter.dispose();
  term.dispose();
});

test("pressured cursor-addressed repaint catches up from the pre-scroll viewport", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 4, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4");
  noteTerminalOutputPressureData(term, "x".repeat(20_000));
  await write(
    term,
    "\x1b[1;1Hscrolled ERROR\r\nline-2\r\nline-3\r\nline-4\r\nline-5\x1b[1;1H",
  );
  await highlighter.whenSettled();

  assert.equal(cellRgb(term, 0, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("row-sized Mosh repaint writes do not rescan the viewport for every row", async () => {
  for (const rows of [40, 80]) {
    const term = new XTerm({ allowProposedApi: true, cols: 80, rows, scrollback: 20 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, Array.from({ length: rows }, (_, index) => `old-${index} ERROR`).join("\r\n"));

    const internal = highlighter as unknown as {
      recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void;
    };
    const originalRecolorRange = internal.recolorRange.bind(highlighter);
    let scannedRows = 0;
    let refreshes = 0;
    internal.recolorRange = (startY, endY, refresh, force) => {
      scannedRows += Math.abs(endY - startY) + 1;
      if (refresh) refreshes += 1;
      originalRecolorRange(startY, endY, refresh, force);
    };

    for (let row = 1; row <= rows; row += 1) {
      await write(term, `\x1b[${row};1Hnew-${row} ERROR`);
    }

    assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), [], `${rows} rows`);
    assert.ok(
      scannedRows <= rows * 2,
      `${rows} rows should stay linear, scanned ${scannedRows} rows`,
    );
    assert.ok(
      refreshes <= rows + 1,
      `${rows} rows should refresh at most once per typical write, got ${refreshes}`,
    );
    highlighter.dispose();
    term.dispose();
  }
});

test("cursor-restoring Mosh row writes keep repaint work linear", async () => {
  for (const rows of [40, 80]) {
    const term = new XTerm({ allowProposedApi: true, cols: 80, rows, scrollback: 20 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, Array.from({ length: rows }, (_, index) => `old-${index} ERROR`).join("\r\n"));
    const internal = highlighter as unknown as {
      recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void;
    };
    const originalRecolorRange = internal.recolorRange.bind(highlighter);
    let scannedRows = 0;
    let refreshes = 0;
    internal.recolorRange = (startY, endY, refresh, force) => {
      scannedRows += Math.abs(endY - startY) + 1;
      if (refresh) refreshes += 1;
      originalRecolorRange(startY, endY, refresh, force);
    };

    for (let row = 1; row <= rows; row += 1) {
      await write(term, `\x1b[${row};1Hnew-${row} ERROR\x1b[1;1H`);
    }

    assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), [], `${rows} rows`);
    assert.ok(scannedRows <= rows * 2, `${rows} rows scanned ${scannedRows}`);
    assert.ok(refreshes <= rows * 2, `${rows} rows refreshed ${refreshes} times`);
    highlighter.dispose();
    term.dispose();
  }
});

test("CUP fragments survive enabling highlighting between writes", async () => {
  for (const control of ["\x1b[2;1H", "\x9b2;1H"]) {
    for (let split = 1; split < control.length; split += 1) {
      const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
      const highlighter = new KeywordHighlighter(term);
      highlighter.setRules(rule(), false);
      await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
      await write(term, control.slice(0, split));
      highlighter.setRules(rule(), true);
      await highlighter.whenSettled();
      await write(term, `${control.slice(split)}target ERROR\x1b[1;1H`);

      assert.equal(cellRgb(term, 1, "ERROR"), RED, `${JSON.stringify(control)} split ${split}`);
      highlighter.dispose();
      term.dispose();
    }
  }
});

test("C1 CUP repaints an earlier viewport row", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");

  await write(term, "\x9b2;1Htarget ERROR\x9b5;1H");

  assert.equal(cellRgb(term, 1, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("out-of-range cursor addresses repaint the clamped viewport row", async () => {
  for (const control of ["\x1b[999;1H", "\x1b[999d", "\x9b999;1H", "\x9b999d"]) {
    const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5\x1b[2;1H");

    await write(term, `${control}target ERROR\x1b[2;1H`);

    assert.equal(cellRgb(term, 4, "ERROR"), RED, JSON.stringify(control));
    highlighter.dispose();
    term.dispose();
  }
});

test("cursor-addressed repaint follows VPR and inserted-line row changes", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1 ERROR\r\nold-2 ERROR\r\nold-3 ERROR\r\nold-4 ERROR");

  await write(term, "\x1b[1;1Hfirst ERROR\x1b[2ethird ERROR\x1b[1;1H");
  await write(term, "\x1b[2;1H\x1b[1Linserted ERROR\x1b[1;1H");

  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("C1 cursor traversal recolors every visited row", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");

  await write(term, "\x9b1;1Hfirst ERROR\x9b2ethird ERROR\x9b1;1H");

  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("single-byte C1 row moves recolor every visited row", async () => {
  for (const control of ["\x84", "\x85", "\x8d"]) {
    const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");

    await write(term, `\x9b2;1Hfirst ERROR${control}second ERROR\x9b2;1H`);

    assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), [], JSON.stringify(control));
    highlighter.dispose();
    term.dispose();
  }
});

test("cursor-addressed auto-wrap scrolling keeps the pre-scroll row highlighted", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 12, rows: 4, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4");

  await write(term, `\x1b[4;1HERROR ${"x".repeat(24)}\x1b[1;1H`);

  assert.ok(term.buffer.active.baseY > 0, "fixture must scroll through auto-wrap");
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("origin-mode cursor addresses stay safe across writes and recover after disable", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");

  await write(term, "\x1b[2;4r\x1b[?");
  await write(term, "6h");
  await write(term, "\x1b[2;1Htarget ERROR\x1b[1;1H");
  assert.equal(cellRgb(term, 2, "ERROR"), RED);

  await write(term, "\x1b[?6l");
  const internal = highlighter as unknown as {
    recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void;
  };
  const originalRecolorRange = internal.recolorRange.bind(highlighter);
  let scannedRows = 0;
  internal.recolorRange = (startY, endY, refresh, force) => {
    scannedRows += Math.abs(endY - startY) + 1;
    originalRecolorRange(startY, endY, refresh, force);
  };
  await write(term, "\x1b[5;1Hnormal ERROR");
  assert.equal(cellRgb(term, 4, "ERROR"), RED);
  assert.ok(scannedRows <= 2, `origin-mode disable should restore the narrow path: ${scannedRows}`);

  highlighter.dispose();
  term.dispose();
});

test("origin mode is remembered while keyword highlighting is disabled", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), false);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
  await write(term, "\x1b[2;4r\x1b[?6h");

  highlighter.setRules(rule(), true);
  await highlighter.whenSettled();
  await write(term, "\x1b[2;1Htarget ERROR\x1b[1;1H");

  assert.equal(cellRgb(term, 2, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("multi-parameter origin mode is recognized at every transport split", async () => {
  for (const control of ["\x1b[?6;25h", "\x1b[?25;6h"]) {
    for (let split = 1; split < control.length; split += 1) {
      const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
      const highlighter = new KeywordHighlighter(term);
      highlighter.setRules(rule(), true);
      await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
      await write(term, "\x1b[2;4r");
      await write(term, control.slice(0, split));
      await write(term, control.slice(split));
      await write(term, "\x1b[2;1Htarget ERROR\x1b[1;1H");

      assert.equal(cellRgb(term, 2, "ERROR"), RED, `${JSON.stringify(control)} split ${split}`);
      await write(term, `${control.slice(0, -1)}l`);
      const internal = highlighter as unknown as {
        recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void;
      };
      const originalRecolorRange = internal.recolorRange.bind(highlighter);
      let scannedRows = 0;
      internal.recolorRange = (startY, endY, refresh, force) => {
        scannedRows += Math.abs(endY - startY) + 1;
        originalRecolorRange(startY, endY, refresh, force);
      };
      await write(term, "\x1b[5;1Hnormal ERROR");
      assert.ok(scannedRows <= 2, `${JSON.stringify(control)} disable split ${split}: ${scannedRows}`);
      highlighter.dispose();
      term.dispose();
    }
  }
});

test("saved origin mode is restored across every cursor-control split", async () => {
  const controls = [
    { save: "\x1b7", restore: "\x1b8", disableHighlightDuringRestore: false },
    { save: "\x1b[s", restore: "\x1b[u", disableHighlightDuringRestore: true },
  ];
  for (const entry of controls) {
    for (let saveSplit = 1; saveSplit < entry.save.length; saveSplit += 1) {
      for (let restoreSplit = 1; restoreSplit < entry.restore.length; restoreSplit += 1) {
        const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
        const highlighter = new KeywordHighlighter(term);
        highlighter.setRules(rule(), true);
        await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
        await write(term, "\x1b[2;4r\x1b[?6h");
        await write(term, entry.save.slice(0, saveSplit));
        await write(term, entry.save.slice(saveSplit));
        await write(term, "\x1b[?6l");
        if (entry.disableHighlightDuringRestore) highlighter.setRules(rule(), false);
        await write(term, entry.restore.slice(0, restoreSplit));
        await write(term, entry.restore.slice(restoreSplit));
        if (entry.disableHighlightDuringRestore) {
          highlighter.setRules(rule(), true);
          await highlighter.whenSettled();
        }
        await write(term, "\x1b[2;1Htarget ERROR\x1b[1;1H");

        const fixture = `${JSON.stringify(entry)} save ${saveSplit} restore ${restoreSplit}`;
        assert.equal(cellRgb(term, 2, "ERROR"), RED, fixture);
        await write(term, "\x1b[?6l");
        const internal = highlighter as unknown as {
          recolorRange(startY: number, endY: number, refresh: boolean, force: boolean): void;
        };
        const originalRecolorRange = internal.recolorRange.bind(highlighter);
        let scannedRows = 0;
        internal.recolorRange = (startY, endY, refresh, force) => {
          scannedRows += Math.abs(endY - startY) + 1;
          originalRecolorRange(startY, endY, refresh, force);
        };
        await write(term, "\x1b[5;1Hnormal ERROR");
        assert.ok(scannedRows <= 2, `${fixture}: ${scannedRows}`);
        highlighter.dispose();
        term.dispose();
      }
    }
  }
});

test("C1 cursor save and restore preserves origin mode", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
  await write(term, "\x9b2;4r\x9b?6;25h\x9bs\x9b?6l\x9bu");

  await write(term, "\x9b2;1Htarget ERROR\x9b1;1H");

  assert.equal(cellRgb(term, 2, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("normal-buffer origin mode survives an alternate-screen round trip", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 24, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old-1\r\nold-2\r\nold-3\r\nold-4\r\nold-5");
  await write(term, "\x1b[2;4r\x1b[?6h\x1b[?1049h");
  await write(term, "\x1b[?6l");
  await write(term, "\x1b[?1049l");
  await write(term, "\x1b[2;1Htarget ERROR\x1b[1;1H");

  assert.equal(cellRgb(term, 2, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("scrolling during a rule change catch-up recolors newly visible rows", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 40, rows: 4, scrollback: 80 });
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 30 }, (_, index) => `line-${index} ERROR`).join("\r\n"));
  bypass = false;
  highlighter.setRules(rule("#60A5FA"), true);
  term.scrollToLine(0);
  assert.equal(cellRgb(term, 0, "ERROR"), BLUE);
  await highlighter.whenSettled();
  highlighter.dispose();
  term.dispose();
});

test("catch-up does not hang when the terminal enters the alternate screen", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => true,
  });
  highlighter.setRules(rule(), true);
  await write(term, "queued ERROR");
  await write(term, "\x1b[?1049hTUI");
  await Promise.race([
    highlighter.whenSettled(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("whenSettled hung")), 200)),
  ]);
  highlighter.dispose();
  term.dispose();
});

test("partial grapheme matches still color the whole cell", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 5, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "letter-e",
    label: "E",
    patterns: ["e"],
    color: "#F87171",
    enabled: true,
  }], true);
  await write(term, "e\u0301");
  assert.equal(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor(), RED);
  highlighter.dispose();
  term.dispose();
});

test("wrapped matches stay on the same logical line", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 8, rows: 6, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "xx ERROR");
  assert.equal(cellRgb(term, 0, "ER") === RED || cellRgb(term, 1, "ROR") === RED, true);
  highlighter.dispose();
  term.dispose();
});

test("quiet catch-up refreshes a tall viewport once", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 40, scrollback: 80 });
  let refreshCount = 0;
  const originalRefresh = term.refresh.bind(term);
  term.refresh = (start, end) => {
    refreshCount += 1;
    return originalRefresh(start, end);
  };
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1 payload=xxxxxxxx";
  const flood = Array.from({ length: 60 }, () => line).join("\r\n");
  noteTerminalOutputPressureData(term, flood);
  await write(term, flood);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  // One refresh paints the viewport in-frame inside the bulk write callback;
  // the second is the single catch-up viewport pass after output quiets.
  assert.equal(refreshCount, 2);
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("identical flood lines are all colored after quiet catch-up", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 12, scrollback: 40 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1 payload=xxxxxxxx";
  for (let index = 0; index < 6; index += 1) {
    noteTerminalOutputPressureData(term, `${line}\r\n`);
    await write(term, `${line}\r\n`);
  }
  const flood = Array.from({ length: 48 }, () => line).join("\r\n");
  noteTerminalOutputPressureData(term, flood);
  await write(term, flood);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("saturated streaming keeps the pinned viewport colored in-frame", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 8 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1";
  const chunk = Array.from({ length: 16 }, () => line).join("\r\n");
  for (let index = 0; index < 4; index += 1) {
    noteTerminalOutputPressureData(term, chunk);
    await write(term, chunk);
  }
  assert.equal(highlighter.rebuildCount, 0);
  const viewportY = term.buffer.active.viewportY;
  // Bulk bypass still colors the visible rows inside the write callback, so
  // streaming logs never show an uncolored frame (#3271).
  assert.equal(cellRgb(term, viewportY, "ERROR"), RED);
  assert.equal(cellRgb(term, viewportY + 2, "ERROR"), RED);
  highlighter.dispose();
  term.dispose();
});

test("hidden panes keep bulk streaming on the deferred catch-up path", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 40 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1";
  const chunk = Array.from({ length: 16 }, () => line).join("\r\n");
  // Below the 16KB/100ms flood gate, so without the background check the bulk
  // bypass would recolor and refresh the viewport for every hidden batch.
  setTerminalOutputPressureVisibility(term, false);
  for (let index = 0; index < 4; index += 1) {
    noteTerminalOutputPressureData(term, chunk);
    await write(term, chunk);
  }
  const viewportY = term.buffer.active.viewportY;
  assert.notEqual(cellRgb(term, viewportY, "ERROR"), RED);
  // Reveal the pane and let catch-up paint the deferred range.
  setTerminalOutputPressureVisibility(term, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("high-rate flood keeps the viewport on the deferred catch-up path", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 8 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1";
  // ~20KB inside the 100ms rate window trips the large-output degradation, so
  // the in-frame viewport repaint stays off and only catch-up colors.
  const chunk = Array.from({ length: 300 }, () => line).join("\r\n");
  for (let index = 0; index < 3; index += 1) {
    noteTerminalOutputPressureData(term, chunk);
    await write(term, chunk);
  }
  assert.equal(highlighter.rebuildCount, 0);
  const viewportY = term.buffer.active.viewportY;
  assert.notEqual(cellRgb(term, viewportY, "ERROR"), RED);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await highlighter.whenSettled();
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});

test("recycled identical flood rows are recolored on catch-up", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 8, scrollback: 12 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const line = "2026-08-13 INFO worker=1 WARN ERROR failed from 10.2.0.1";
  const flood = Array.from({ length: 40 }, () => line).join("\r\n");
  noteTerminalOutputPressureData(term, flood);
  await write(term, flood);
  noteTerminalOutputPressureData(term, flood);
  await write(term, flood);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
  highlighter.dispose();
  term.dispose();
});


test("hibernate replay defers bulk viewport coloring but subsequent live output colors immediately", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const chunk = Array.from({ length: 20 }, () => "history ERROR").join("\r\n");
  try {
    await writeTerminalPayloadChunked(term, chunk);
    assert.notEqual(cellRgb(term, term.buffer.active.viewportY, "ERROR"), RED);
    await highlighter.whenSettled();
    assert.deepEqual(uncoloredKeywordLines(term, "ERROR", RED), []);
    await write(term, "\r\n" + chunk);
    assert.equal(cellRgb(term, term.buffer.active.viewportY, "ERROR"), RED);
  } finally {
    highlighter.dispose();
    term.dispose();
  }
});


test("bulk streaming does not recolor a scrolled-back history viewport", async () => {
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 6, scrollback: 100 });
  let bypass = false;
  const highlighter = new KeywordHighlighter(term, { shouldBypassHighlight: () => bypass });
  highlighter.setRules(rule(), true);
  const chunk = Array.from({ length: 20 }, () => "log ERROR").join("\r\n") + "\r\n";
  try {
    await write(term, chunk);
    await highlighter.whenSettled();
    term.scrollToTop();
    let refreshes = 0;
    const refresh = term.refresh.bind(term);
    term.refresh = (start, end) => { refreshes += 1; refresh(start, end); };
    bypass = true;
    await write(term, chunk);
    const scrollRefreshes = refreshes;
    refreshes = 0;
    bypass = false;
    await write(term, chunk);
    assert.equal(refreshes, scrollRefreshes, "bulk callback must not add another history repaint");
    term.scrollToBottom();
    await write(term, chunk);
    assert.equal(cellRgb(term, term.buffer.active.viewportY, "ERROR"), RED);
  } finally {
    highlighter.dispose();
    term.dispose();
  }
});
