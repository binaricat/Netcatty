import assert from "node:assert/strict";
import test from "node:test";

import {
  createReplaySafeTerminalLog,
  createReplaySafeTerminalLogSanitizer,
} from "./replaySafeTerminalLog";

test("common shell clear sequence is safe to replay", () => {
  const log = createReplaySafeTerminalLog("login banner\n$ clear\n\x1b[H\x1b[2J\x1b[3Jafter clear\n");

  assert.equal(log, "login banner\n$ clear\n\r\nafter clear\n");
  assert.equal(log.includes("\x1b[2J"), false);
  assert.equal(log.includes("\x1b[3J"), false);
});

test("display clear followed by cursor home keeps prior replay history", () => {
  assert.equal(
    createReplaySafeTerminalLog("old1\nold2\n\x1b[2J\x1b[Hnew\n"),
    "old1\nold2\n\r\nnew\n",
  );
});

test("home erase-to-end clear keeps prior replay history", () => {
  assert.equal(
    createReplaySafeTerminalLog("before zellij\n$ zellij\n\x1b[H\x1b[Jzellij pane\n"),
    "before zellij\n$ zellij\n\r\nzellij pane\n",
  );
});

test("repeated home erase-to-end clears create fresh replay sections", () => {
  const log = createReplaySafeTerminalLog("history\n\x1b[2Jframe1\x1b[H\x1b[Jframe2\n");

  assert.equal(log, "history\n\r\nframe1\r\n\r\nframe2\n");
  assert.equal(log.includes("\x1b[H"), false);
  assert.equal(log.includes("\x1b[J"), false);
});

test("repeated cursor home before clear does not overwrite replay history", () => {
  const log = createReplaySafeTerminalLog("old1\nold2\n\x1b[H\x1b[H\x1b[2Jafter\n");

  assert.equal(log, "old1\nold2\n\r\nafter\n");
  assert.equal(log.includes("\x1b[H"), false);
});

test("mode controls after clear do not allow later home to overwrite history", () => {
  const log = createReplaySafeTerminalLog("history\n\x1b[H\x1b[2J\x1b[?25l\x1b[Hnew\n");

  assert.equal(log, "history\n\r\n\x1b[?25lnew\n");
});

test("cursor positioning after clear does not overwrite replay history", () => {
  const log = createReplaySafeTerminalLog(
    "old1\nold2\n\x1b[2J\x1b[10;5Hpanel\x1b[999Aup\x1b[5Fprev\x1b[12drow\x1b[20Gcol\n",
  );

  assert.equal(log, "old1\nold2\n\r\npanelupprevrowcol\n");
  assert.equal(log.includes("\x1b[10;5H"), false);
  assert.equal(log.includes("\x1b[999A"), false);
  assert.equal(log.includes("\x1b[5F"), false);
  assert.equal(log.includes("\x1b[12d"), false);
  assert.equal(log.includes("\x1b[20G"), false);
});

test("cursor home after protected clear is dropped when no erase follows", () => {
  const log = createReplaySafeTerminalLog("old\n\x1b[2Jframe\x1b[H\x1b[?25ltext\n");

  assert.equal(log, "old\n\r\nframe\x1b[?25ltext\n");
  assert.equal(log.includes("\x1b[H"), false);
});

test("single-character cursor controls after clear do not overwrite replay history", () => {
  const log = createReplaySafeTerminalLog("old\n\x1b[2J\x1bMri\x8dc1ri\x1bDind\x84c1ind\x1bEnel\x85c1nel\n");

  assert.equal(log, "old\n\r\nric1riindc1indnelc1nel\n");
  assert.equal(log.includes("\x1bM"), false);
  assert.equal(log.includes("\x8d"), false);
  assert.equal(log.includes("\x1bD"), false);
  assert.equal(log.includes("\x84"), false);
  assert.equal(log.includes("\x1bE"), false);
  assert.equal(log.includes("\x85"), false);
});

test("queued cursor and erase controls before clear are not preserved", () => {
  const log = createReplaySafeTerminalLog("old\n\x1b[H\x1b[2;1H\x1b[K\x1b[s\x1b[u\x1b[?25l\x1b[2Jnew\n");

  assert.equal(log, "old\n\r\n\x1b[?25lnew\n");
  assert.equal(log.includes("\x1b[2;1H"), false);
  assert.equal(log.includes("\x1b[K"), false);
  assert.equal(log.includes("\x1b[s"), false);
  assert.equal(log.includes("\x1b[u"), false);
});

test("cursor save and restore are preserved before any protected clear", () => {
  const log = createReplaySafeTerminalLog("abc\x1b[sXYZ\x1b[u!");

  assert.equal(log, "abc\x1b[sXYZ\x1b[u!");
});

test("pending cursor-home controls are preserved when no clear follows", () => {
  const log = createReplaySafeTerminalLog("abc\x1b[H\x1b[s\x1b[2;1HXYZ");

  assert.equal(log, "abc\x1b[H\x1b[s\x1b[2;1HXYZ");
});

test("mode controls between home and erase are kept without preserving clear controls", () => {
  const log = createReplaySafeTerminalLog("history\n\x1b[H\x1b[?25l\x1b[Jnew\n");

  assert.equal(log, "history\n\r\n\x1b[?25lnew\n");
});

test("erase-display backward controls are dropped from replay data", () => {
  const log = createReplaySafeTerminalLog("old\n\x1b[2Jnew\x1b[1Jafter\n");

  assert.equal(log, "old\n\r\nnew\r\n\r\nafter\n");
  assert.equal(log.includes("\x1b[1J"), false);
});

test("scrollback-only clears protect replay history", () => {
  const log = createReplaySafeTerminalLog("history\n\x1b[3J\x1b[Hoverwrite\n");

  assert.equal(log, "history\n\r\noverwrite\n");
  assert.equal(log.includes("\x1b[3J"), false);
  assert.equal(log.includes("\x1b[H"), false);
});

test("terminal control strings are stripped from replay data", () => {
  const log = createReplaySafeTerminalLog(
    "before\x1b]52;c;secret\x07mid\x1b]7;file://host/path\x1b\\"
      + "dcs\x1bP1$rpayload\x1b\\apc\x1b_payload\x1b\\pm\x1b^payload\x1b\\"
      + "sos\x1bXpayload\x1b\\c1sos\x98hidden\x9cafter",
  );

  assert.equal(log, "beforemiddcsapcpmsosc1sosafter");
  assert.equal(log.includes("\x1b"), false);
  assert.equal(log.includes("secret"), false);
  assert.equal(log.includes("payload"), false);
  assert.equal(log.includes("hidden"), false);
});

test("split terminal control strings are stripped before truncation", () => {
  const sanitizer = createReplaySafeTerminalLogSanitizer();
  const hiddenPayload = "secret".repeat(200_000);
  let captured = "";

  captured += sanitizer.append("before\x1b]52;c;");
  captured = captured.slice(-1_000_000);
  captured += sanitizer.append(hiddenPayload);
  captured = captured.slice(-1_000_000);
  captured += sanitizer.append("\x07after");
  captured = captured.slice(-1_000_000);
  captured += sanitizer.finish();

  assert.equal(captured, "beforeafter");
  assert.equal(captured.includes("secret"), false);
});

test("overlong pending csi data is discarded until the sequence ends", () => {
  const sanitizer = createReplaySafeTerminalLogSanitizer();
  const parameters = "1;".repeat(3000);

  const log = sanitizer.append(`before\x1b[${parameters}`)
    + sanitizer.append(parameters)
    + sanitizer.append("mafter")
    + sanitizer.finish();

  assert.equal(log, "beforeafter");
  assert.equal(log.includes(parameters.slice(0, 32)), false);
});

test("pending cursor-home lookahead controls are bounded before clear", () => {
  const controls = "\x1b[31m".repeat(900);
  const log = createReplaySafeTerminalLog(`old\n\x1b[H${controls}\x1b[2Jnew\n`);

  assert.equal(log, "old\n\r\nnew\n");
  assert.equal(log.includes("\x1b[31m"), false);
});

test("alternate-screen entry protects preserved replay history", () => {
  const log = createReplaySafeTerminalLog(
    "before\n\x1b[?1049h\x1b[Hvim screen\n\x1b[?1049lafter\n"
      + "\x1b[?47h\x1b[10;5Htop screen\n\x1b[?47l"
      + "\x1b[?25lcursor hidden\n",
  );

  assert.equal(log, "before\n\r\nvim screen\nafter\n\r\ntop screen\n\x1b[?25lcursor hidden\n");
  assert.equal(log.includes("\x1b[?1049h"), false);
  assert.equal(log.includes("\x1b[?1049l"), false);
  assert.equal(log.includes("\x1b[?47h"), false);
  assert.equal(log.includes("\x1b[?47l"), false);
  assert.equal(log.includes("\x1b[H"), false);
  assert.equal(log.includes("\x1b[10;5H"), false);
  assert.equal(log.includes("\x1b[?25l"), true);
});

test("dec cursor save mode is not treated as alternate screen", () => {
  const log = createReplaySafeTerminalLog("before\n\x1b[?1048h\x1b[?1048l\x1b[10;5Hpositioned\n");

  assert.equal(log, "before\n\x1b[?1048h\x1b[?1048l\x1b[10;5Hpositioned\n");
});

test("cursor save and restore controls are stripped around protected clears", () => {
  const log = createReplaySafeTerminalLog("old\n\x1b[s\x1b7\x1b[2J\x1b[uafter\x1b8done\n");

  assert.equal(log, "old\n\x1b[s\x1b7\r\n\r\nafterdone\n");
  assert.equal(log.includes("\x1b[s"), true);
  assert.equal(log.includes("\x1b[u"), false);
  assert.equal(log.includes("\x1b7"), true);
  assert.equal(log.includes("\x1b8"), false);
});

test("terminal reset controls are dropped from replay data", () => {
  const log = createReplaySafeTerminalLog("before\x1bcafter\n");

  assert.equal(log, "before\r\n\r\nafter\n");
  assert.equal(log.includes("\x1bc"), false);
});

test("split terminal reset controls are dropped from replay data", () => {
  const sanitizer = createReplaySafeTerminalLogSanitizer();

  const log = sanitizer.append("before\x1b")
    + sanitizer.append("cafter\n")
    + sanitizer.finish();

  assert.equal(log, "before\r\n\r\nafter\n");
  assert.equal(log.includes("\x1bc"), false);
});

test("non-clear cursor and color controls are preserved", () => {
  const input = "\x1b[H\x1b[31mred\x1b[0m\n";

  assert.equal(createReplaySafeTerminalLog(input), input);
});
