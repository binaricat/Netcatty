const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTerminalTextRenderer,
  terminalDataToPlainText,
} = require("./terminalLogSanitizer.cjs");
const { terminalDataToHtml } = require("./sessionLogsBridge.cjs");

test("plain text rendering applies backspace edits", () => {
  assert.equal(terminalDataToPlainText("hellp\bo\n"), "hello");
});

test("plain text rendering applies carriage-return overwrites", () => {
  assert.equal(terminalDataToPlainText("progress 10%\rprogress 100%\n"), "progress 100%");
});

test("plain text rendering applies erase-line controls", () => {
  assert.equal(terminalDataToPlainText("loading...\r\x1b[Kdone\n"), "done");
});

test("erase display from carriage return preserves overwrite semantics", () => {
  assert.equal(terminalDataToPlainText("progress 10%\r\x1b[Jprogress 20%\n"), "progress 20%");
});

test("stateful renderer handles CSI sequences split across chunks", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("red \x1b[");
  renderer.feed("31mtext\x1b[0m\n");
  assert.equal(renderer.finish(), "red text");
});

test("plain text rendering removes OSC payloads", () => {
  assert.equal(terminalDataToPlainText("before\x1b]0;secret title\x07after\n"), "beforeafter");
});

test("HTML rendering escapes content and strips terminal controls", () => {
  const html = terminalDataToHtml("a < b\x1b[31m & c\x1b[0m\r\x1b[Kdone\n", "host<1>", 0);
  assert.equal(html.includes("\x1b"), false);
  assert.equal(html.includes("[31m"), false);
  assert.equal(html.includes("done"), true);
  assert.equal(html.includes("a &lt; b"), false);
  assert.equal(html.includes("host&lt;1&gt;"), true);
});

test("display clear preserves prior log history", () => {
  assert.equal(
    terminalDataToPlainText("login banner\n$ tmux\n\x1b[H\x1b[2Jtmux pane\n"),
    "login banner\n$ tmux\n\ntmux pane",
  );
});

test("ED3 after ED2 does not add a duplicate log separator", () => {
  assert.equal(
    terminalDataToPlainText("login banner\n$ clear\n\x1b[H\x1b[2J\x1b[3Jafter clear\n"),
    "login banner\n$ clear\n\nafter clear",
  );
});

test("cursor home after display clear stays within the new log screen", () => {
  assert.equal(
    terminalDataToPlainText("old1\nold2\n\x1b[2J\x1b[Hnew\n"),
    "old1\nold2\n\nnew",
  );
});

test("erase display backward after full clear preserves prior log history", () => {
  assert.equal(
    terminalDataToPlainText("old\n\x1b[2Jnew\x1b[1Jafter\n"),
    "old\n\n   after",
  );
});

test("clear from home preserves prior log history", () => {
  assert.equal(
    terminalDataToPlainText("before zellij\n$ zellij\n\x1b[H\x1b[Jzellij pane\n"),
    "before zellij\n$ zellij\n\nzellij pane",
  );
});

test("home clear repaint updates current preserved screen instead of appending frames", () => {
  assert.equal(
    terminalDataToPlainText("before tui\n\x1b[H\x1b[Jframe one\n\x1b[H\x1b[Jframe two\n"),
    "before tui\n\nframe two",
  );
});

test("home ED2 preserves cleared screens even without ED3", () => {
  assert.equal(
    terminalDataToPlainText("before tui\n\x1b[H\x1b[2Jframe one\n\x1b[H\x1b[2Jframe two\n"),
    "before tui\n\nframe one\n\nframe two",
  );
});

test("repeated ED2 preserves cleared screens even without ED3", () => {
  assert.equal(
    terminalDataToPlainText("before tui\n\x1b[2Jframe one\r\x1b[2Jframe two\n"),
    "before tui\n\nframe one\n\nframe two",
  );
});

test("redundant ED2 keeps pending cleared screen when current screen is empty", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[2Jfirst\x1b[2J\x1b[2Jsecond\n"),
    "before\n\nfirst\n\n     second",
  );
});

test("home ED2 preserves each cleared shell frame without ED3", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[H\x1b[2Jone\n\x1b[H\x1b[2Jtwo\n"),
    "before\n\none\n\ntwo",
  );
});

test("home ED2 repaint does not accumulate every intermediate frame", () => {
  assert.equal(
    terminalDataToPlainText("before tui\n\x1b[H\x1b[2Jframe one\n\x1b[H\x1b[2Jframe two\n\x1b[H\x1b[2Jframe three\n"),
    "before tui\n\nframe two\n\nframe three",
  );
});

test("committing pending ED2 preserves cursor movement before printable output", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[H\x1b[2Jone\n\x1b[2J\x1b[10;5Htext\n"),
    "before\n\none\n\n\n\n\n\n\n\n\n\n\n    text",
  );
});

test("pending ED2 snapshot rendering does not mutate repaint state", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("before tui\n\x1b[H\x1b[2Jframe one\n\x1b[H\x1b[2Jframe two\n");
  assert.equal(
    renderer.toString({ includePendingClearedScreen: true }),
    "before tui\n\nframe one\n\nframe two",
  );

  renderer.feed("\x1b[H\x1b[2Jframe three\n");
  assert.equal(renderer.finish(), "before tui\n\nframe two\n\nframe three");
});

test("later shell clear preserves intervening screen output", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[H\x1b[2Jfirst screen\n\x1b[H\x1b[2J\x1b[3Jsecond screen\n"),
    "before\n\nfirst screen\n\nsecond screen",
  );
});

test("standalone ED3 preserves current visible screen", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[H\x1b[2Jscreen\n\x1b[3Jafter\n"),
    "before\n\nscreen\nafter",
  );
});

test("alternate screen body is omitted from plain text session logs", () => {
  assert.equal(
    terminalDataToPlainText(
      "$ vim file\n\x1b[?1049h\x1b[H~\n~\n\"file\" 0L, 0B\x1b[?1049l$ ls\n",
    ),
    "$ vim file\n$ ls",
  );
});

test("alternate screen omit tracks enter/leave split across chunks", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("$ vim\n\x1b[?1049");
  renderer.feed("h\x1b[H~\nstatus line");
  renderer.feed("\x1b[?1049l$ done\n");
  assert.equal(renderer.finish(), "$ vim\n$ done");
});

test("seeded alternate screen omits TUI paint until leave", () => {
  const renderer = createTerminalTextRenderer({ alternateScreenActive: true });
  renderer.feed("~\nstatus line\n");
  renderer.feed("\x1b[?1049l$ done\n");
  assert.equal(renderer.finish(), "$ done");
});

test("legacy smcup/rmcup alternate screen modes are omitted", () => {
  assert.equal(
    terminalDataToPlainText("shell\n\x1b[?47hTUI\n\x1b[?47lafter\n"),
    "shell\nafter",
  );
  assert.equal(
    terminalDataToPlainText("shell\n\x1b[?1047hTUI\n\x1b[?1047lafter\n"),
    "shell\nafter",
  );
});

test("RIS during alternate screen restores logging of later shell output", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x1b[?1049hTUI\x1bcshell-after\n"),
    "before\nshell-after",
  );
});

test("split RIS during alternate screen restores logging of later shell output", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("before\n\x1b[?1049hTUI\x1b");
  renderer.feed("cshell-after\n");
  assert.equal(renderer.finish(), "before\nshell-after");
});

test("RIS after mid-line TUI does not glue post-reset shell text", () => {
  assert.equal(
    terminalDataToPlainText("before\x1b[?1049hTUI\x1bcshell-after\n"),
    "before\nshell-after",
  );
});

test("RIS resets SGR so post-reset text is not colored from pre-entry style", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("\x1b[31mbefore\x1b[?1049hTUI\x1bcshell-after\n");
  const html = renderer.toHtmlContent();
  assert.match(html, /shell-after/);
  // Pre-entry red SGR must not wrap post-RIS shell text.
  assert.equal(/color:\s*var\(--ansi-1[^)]*\)[^"]*"[^>]*>shell-after/.test(html), false);
  assert.match(html, /color:\s*var\(--ansi-1[^)]*\)[^"]*"[^>]*>before/);
});

test("RIS rebases screen so later cursor-home does not overwrite history", () => {
  // Post-reset "shell" can be partially overwritten by home+write on the new
  // screen ("newll"), but pre-RIS history ("before") must remain intact.
  // Without rebasing, CSI H would rewrite history into something like "newore".
  const log = terminalDataToPlainText("before\x1bcshell\x1b[Hnew");
  assert.equal(log.startsWith("before\n"), true);
  assert.equal(log.includes("new"), true);
  assert.equal(log.startsWith("newore"), false);
  assert.equal(log, "before\nnewll");
});


test("C1 CSI alternate-screen modes are omitted like ESC [ forms", () => {
  assert.equal(
    terminalDataToPlainText("before\n\x9b?1049hTUI\n\x9b?1049lafter\n"),
    "before\nafter",
  );
  assert.equal(
    terminalDataToPlainText("before\n\x9b?47hTUI\n\x9b?47lafter\n"),
    "before\nafter",
  );
});

test("split C1 CSI alternate-screen enter still omits TUI paint", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("before\n\x9b?1049");
  renderer.feed("h~\nstatus\n");
  renderer.feed("\x9b?1049l$ done\n");
  assert.equal(renderer.finish(), "before\n$ done");
});

test("SGR colors are emitted as themeable CSS variables with hex fallbacks", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("\x1b[31mred \x1b[91mbright-red \x1b[44mbg-blue \x1b[0mplain\n");
  const html = renderer.toHtmlContent();
  // Basic / bright / background colors map to --ansi-N variables so the
  // wrapping HTML page can swap palettes for light and dark themes.
  assert.match(html, /color:\s*var\(--ansi-1, #cd3131\)[^"]*"[^>]*>red/);
  assert.match(html, /color:\s*var\(--ansi-9, #f14c4c\)[^"]*"[^>]*>bright-red/);
  assert.match(html, /color:\s*#f14c4c; background-color:\s*#2472c8/);
});

test("256-color base and cube foregrounds use themeable variables", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("\x1b[38;5;1mbase\x1b[0m \x1b[38;5;208mcube\n");
  const html = renderer.toHtmlContent();
  assert.match(html, /color:\s*var\(--ansi-1, #cd3131\)[^"]*"[^>]*>base/);
  assert.match(html, /color:\s*var\(--term-custom-ff8700, #ff8700\)[^"]*"[^>]*>cube/);
});

test("inverse text falls back to themeable default background/foreground", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("\x1b[7minversed\x1b[0m\n");
  const html = renderer.toHtmlContent();
  assert.match(
    html,
    /color:\s*var\(--term-default-bg, #1e1e1e\); background-color:\s*var\(--term-default-fg, #d4d4d4\)/,
  );
});

test("explicit backgrounds preserve original foreground/background pairs across themes", () => {
  const renderer = createTerminalTextRenderer();
  renderer.feed("\x1b[37;41mERROR\x1b[0m \x1b[40mTEXT\x1b[0m \x1b[38;5;15;48;5;1mindexed\x1b[0m \x1b[31;7minverse\x1b[0m \x1b[48;2;0;0;0mRGB background\x1b[0m");
  const html = renderer.toHtmlContent();
  assert.match(html, /color: #e5e5e5; background-color: #cd3131[^>]*>ERROR/);
  assert.match(html, /color: #d4d4d4; background-color: #000000[^>]*>TEXT/);
  assert.match(html, /color: #ffffff; background-color: #cd3131[^>]*>indexed/);
  assert.match(html, /color: #1e1e1e; background-color: #cd3131[^>]*>inverse/);
  assert.match(html, /color: #d4d4d4; background-color: #000000[^>]*>RGB background/);
});
