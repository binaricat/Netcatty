import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { createTerminalOutputHistoryPreview } from "./terminalOutputHistory.ts";

const { Terminal: XTerm } = createRequire(import.meta.url)("@xterm/xterm") as { Terminal: typeof Terminal };
// Exercise the production resize listener without mounting the WebGL/UI runtime.
// The terminal buffer and history collector are real; only unrelated effects
// (atlas clearing and backend resize scheduling) are inert in this harness.
const runtime = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const start = runtime.indexOf("  term.onResize(({ cols, rows }) => {");
assert.notEqual(start, -1);
const listenerSource = runtime.slice(start, runtime.indexOf("\n  });", start) + "\n  });".length);
function createHarness(cols: number) {
  const term = new XTerm({ cols, rows: 24, allowProposedApi: true, convertEol: true });
  const history = createTerminalOutputHistoryPreview();
  new Function("term", "ctx", "clearWebglTextureAtlas", "resizeScheduler", listenerSource)(
    term, { terminalOutputHistory: history, sessionRef: { current: null } }, () => {}, { schedule() {} },
  );
  const write = async (data: string) => {
    history.setViewportRows(term.rows);
    history.setViewportCols(term.cols);
    history.append(data);
    await new Promise<void>((resolve) => term.write(data, resolve));
  };
  return { term, history, write };
}

for (const alternate of [false, true]) test(`idle ${alternate ? "alternate" : "normal"}-screen resize updates history before any new output`, async () => {
  const { term, history, write } = createHarness(10);
  try {
    await write(`${alternate ? "\x1b[?1049h" : ""}abcdefgh`);
    history.getPreviewRows({ cols: 10, rows: 1, top: 0 });
    term.resize(5, 24);
    assert.equal(history.getPreviewRowCount(5), 1);
    assert.equal(history.getPreviewRows({ cols: 5, rows: 1, top: 0 }).rows[0].text,
      term.buffer.active.getLine(0)?.translateToString(true, 0, term.cols));
    term.resize(10, 24);
    assert.equal(history.getPreviewRows({ cols: 10, rows: 1, top: 0 }).rows[0].text,
      term.buffer.active.getLine(0)?.translateToString(true, 0, term.cols));
  } finally { term.dispose(); }
});

test("resize uses xterm's reflowed cursor for later same-row redraws", async () => {
  const { term, history, write } = createHarness(5);
  try {
    await write("abcdef\n");
    term.resize(10, 24);
    assert.equal(term.buffer.active.cursorY, 1);
    await write("X\x1b[2;2HY");
    assert.deepEqual(history.getPreviewRows({ cols: 10, rows: 2, top: 0 }).rows.map(row => row.text),
      [term.buffer.active.getLine(0)?.translateToString(true), term.buffer.active.getLine(1)?.translateToString(true)]);
  } finally { term.dispose(); }
});

for (const chunks of [["abc中X"], ["abc中XYZ"], ["abc中文X"], ["abc中文", "X"], ["abc中\x1b[5GZ"]]) {
  test(`no-autowrap final wide cell matches xterm: ${JSON.stringify(chunks)}`, async () => {
    const { term, history, write } = createHarness(5);
    try {
      await write("\x1b[?7l");
      for (const chunk of chunks) await write(chunk);
      assert.equal(history.getLines().at(-1), term.buffer.active.getLine(0)?.translateToString(true));
    } finally { term.dispose(); }
  });
}

for (const [save, restore] of [["\x1b7", "\x1b8"], ["\x1b[s", "\x1b[u"]]) {
  test(`cursor restore also restores wrapping mode: ${JSON.stringify(save)}`, async () => {
    const { term, history, write } = createHarness(5);
    try {
      await write(`\x1b[?7l${save}\x1b[?7h${restore}abcdef`);
      assert.deepEqual(history.getLines(), [term.buffer.active.getLine(0)?.translateToString(true)]);
    } finally { term.dispose(); }
  });
  test(`cursor restore also restores origin mode: ${JSON.stringify(save)}`, async () => {
    const { term, history, write } = createHarness(5);
    try {
      await write(`\x1b[2;5r\x1b[?6h${save}\x1b[?6lA${restore}X\x1b[1;2HY`);
      assert.deepEqual(history.getLines(), [term.buffer.active.getLine(0)?.translateToString(true), term.buffer.active.getLine(1)?.translateToString(true)]);
    } finally { term.dispose(); }
  });
}
