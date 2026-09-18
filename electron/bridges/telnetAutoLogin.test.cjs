const test = require("node:test");
const assert = require("node:assert/strict");

const { createTelnetAutoLogin } = require("./telnetAutoLogin.cjs");

test("telnet auto-login sends saved username and password for split prompts", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("\x1b[32mUser");
  autoLogin.handleText("name:\x1b[0m ");
  autoLogin.handleText("\r\nPass");
  autoLogin.handleText("word: ");

  assert.deepEqual(writes, ["admin\r", "secret\r"]);
});

test("telnet auto-login completes only after a command prompt appears", () => {
  const writes = [];
  let completeCount = 0;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
    onComplete: () => { completeCount += 1; },
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["admin\r", "secret\r"]);
  assert.equal(completeCount, 0);

  autoLogin.handleText("\r\nWelcome\r\nrouter# ");
  autoLogin.handleText("\r\nrouter# ");

  assert.equal(completeCount, 1);
});

test("telnet auto-login does not complete username-only login until the prompt appears", () => {
  const writes = [];
  let completed = false;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    write: (data) => writes.push(data),
    onComplete: () => { completed = true; },
  });

  autoLogin.handleText("Username: ");

  assert.deepEqual(writes, ["admin\r"]);
  assert.equal(completed, false);

  autoLogin.handleText("\r\nrouter> ");

  assert.equal(completed, true);
});

test("telnet auto-login completes when a password-ready host only asks for username", () => {
  const writes = [];
  let completed = false;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
    onComplete: () => { completed = true; },
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nrouter# ");

  assert.deepEqual(writes, ["admin\r"]);
  assert.equal(completed, true);
});

test("telnet auto-login sends username before password when prompts arrive together", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Username: \r\nPassword: ");

  assert.deepEqual(writes, ["admin\r", "secret\r"]);
});

test("telnet auto-login supports password-only prompts", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    password: "line-password",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Password: ");

  assert.deepEqual(writes, ["line-password\r"]);
});

test("telnet auto-login sends a blank username before a saved password", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "",
    password: "line-password",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "line-password\r"]);
});

test("telnet auto-login sends an intentionally blank password", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["admin\r", "\r"]);
});

test("telnet auto-login wakes devices that ask for return before login", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Press RETURN to get started.");
  autoLogin.handleText("\r\nrouter login: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
});

test("telnet auto-login wakes devices that ask for bracketed enter", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Press <ENTER> to continue");
  autoLogin.handleText("\r\nUsername: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
});

test("telnet auto-login wakes devices that ask for square-bracketed enter", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Press [Enter] to continue");
  autoLogin.handleText("\r\nUsername: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
});

test("telnet auto-login handles prompts concatenated after wake banners", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Press RETURN to get started.");
  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
});

test("telnet auto-login handles wake banners concatenated with preceding text", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Netcatty local Telnet test servicePress RETURN to get started.");
  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["\r", "admin\r", "secret\r"]);
});

test("telnet auto-login stops when the user starts typing manually", () => {
  const writes = [];
  let cancelCount = 0;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
    onUserInput: () => { cancelCount += 1; },
  });

  autoLogin.handleUserInput();
  autoLogin.handleUserInput();
  autoLogin.handleText("Username: ");
  autoLogin.handleText("Password: ");

  assert.deepEqual(writes, []);
  assert.equal(cancelCount, 1);
});

test("telnet auto-login avoids common non-prompt login text", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Last login:");

  assert.deepEqual(writes, []);
});

test("telnet auto-login works with Kylin-style prompts without trailing colon", () => {
  // Kylin Professional prompts may lack trailing colon or angle-bracket (#1293)
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Username");
  autoLogin.handleText("\r\nPassword");

  assert.deepEqual(writes, ["admin\r", "secret\r"]);
});

test("telnet auto-login works with Kylin-style Chinese prompts without trailing colon", () => {
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("用户名");
  autoLogin.handleText("\r\n密码");

  assert.deepEqual(writes, ["admin\r", "secret\r"]);
});

test("telnet auto-login works with Kylin V10 Input Password prompt from issue #1293", () => {
  // Screenshot: "lybing-pc login: lybing" then "Input Password" (no trailing colon)
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "lybing",
    password: "secret",
    write: (data) => writes.push(data),
  });

  autoLogin.handleText("Kylin V10 SP1\r\nlybing-pc login: ");
  autoLogin.handleText("Input Password");

  assert.deepEqual(writes, ["lybing\r", "secret\r"]);
});

test("telnet auto-login notifies incomplete when the device asks for a password that is not saved", () => {
  const writes = [];
  let completed = false;
  let incomplete = 0;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    write: (data) => writes.push(data),
    onComplete: () => { completed = true; },
    onIncomplete: () => { incomplete += 1; },
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");

  assert.deepEqual(writes, ["admin\r"]);
  assert.equal(completed, false);
  assert.equal(incomplete, 1);

  // The detector stays alive: if the device moves on to a command prompt the
  // exchange can still complete.
  autoLogin.handleText("\r\nrouter# ");

  assert.equal(completed, true);
  assert.equal(incomplete, 1);
});

test("telnet auto-login notifies incomplete when the window expires mid-exchange", () => {
  let clock = 0;
  let incomplete = 0;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: () => {},
    now: () => clock,
    timeoutMs: 60_000,
    onIncomplete: () => { incomplete += 1; },
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");
  // Login failed: the device re-prompts and the detector cannot recover.
  autoLogin.handleText("\r\nUsername: ");
  assert.equal(incomplete, 0);

  clock = 60_001;
  autoLogin.handleText("\r\nUsername: ");
  assert.equal(incomplete, 1);

  // Idempotent: further chunks after expiry do not re-notify.
  autoLogin.handleText("more output");
  assert.equal(incomplete, 1);
});

test("telnet auto-login does not notify incomplete for quiet devices", () => {
  let clock = 0;
  let incomplete = 0;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    write: () => {},
    now: () => clock,
    timeoutMs: 60_000,
    onIncomplete: () => { incomplete += 1; },
  });

  autoLogin.handleText("\r\nWelcome banner\r\n");
  clock = 60_001;
  autoLogin.handleText("\r\nmore banner");

  // Quiet devices never interact, so the caller's quiet-device fallback
  // remains valid.
  assert.equal(incomplete, 0);
});

test("telnet auto-login owns an expiry timer: rejected login gone silent reports incomplete", () => {
  let incomplete = 0;
  let timerFn = null;
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: () => {},
    timeoutMs: 60_000,
    onIncomplete: () => { incomplete += 1; },
    setTimeout: (fn) => {
      timerFn = fn;
      return { unref: () => {} };
    },
    clearTimeout: () => {},
  });

  // The device rejects the saved credentials and re-prompts.
  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");
  autoLogin.handleText("\r\nUsername: ");
  // Then it goes silent: no further bytes arrive, so handleText is never
  // called after expiry. The detector's own timer must report the stall.
  assert.equal(typeof timerFn, "function");
  assert.equal(incomplete, 0);
  timerFn();

  assert.equal(incomplete, 1);
});

test("telnet auto-login expiry timer stays silent for quiet devices", () => {
  let incomplete = 0;
  let timerFn = null;
  createTelnetAutoLogin({
    username: "admin",
    write: () => {},
    timeoutMs: 60_000,
    onIncomplete: () => { incomplete += 1; },
    setTimeout: (fn) => {
      timerFn = fn;
      return { unref: () => {} };
    },
    clearTimeout: () => {},
  });

  // No credentials were ever sent, so the caller's quiet-device fallback
  // (typing the startup command) remains valid.
  timerFn();

  assert.equal(incomplete, 0);
});

test("telnet auto-login expiry timer does not fire after a completed exchange", () => {
  let completed = 0;
  let incomplete = 0;
  let timerFn = null;
  const timers = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: () => {},
    timeoutMs: 60_000,
    onComplete: () => { completed += 1; },
    onIncomplete: () => { incomplete += 1; },
    setTimeout: (fn) => {
      timerFn = fn;
      const id = { unref: () => {} };
      timers.push(id);
      return id;
    },
    clearTimeout: () => {
      const index = timers.indexOf(timerFn);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");
  autoLogin.handleText("\r\nrouter# ");

  assert.equal(completed, 1);
  // The exchange completed; firing a stale timer must be a no-op.
  timerFn();

  assert.equal(completed, 1);
  assert.equal(incomplete, 0);
});

test("cancel() disables the detector and clears the expiry timer", () => {
  let incomplete = 0;
  let completed = 0;
  let timerFn;
  const timers = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: () => {},
    timeoutMs: 60_000,
    onComplete: () => { completed += 1; },
    onIncomplete: () => { incomplete += 1; },
    setTimeout: (fn) => {
      timerFn = fn;
      const id = { unref: () => {} };
      timers.push(id);
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.indexOf(id);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  // Credentials were sent, so a later expiry would report an incomplete
  // exchange. Cancelling (as when the session is displaced by a reconnect)
  // must disarm that path entirely.
  autoLogin.handleText("Username: ");
  autoLogin.handleText("\r\nPassword: ");
  autoLogin.cancel();

  timerFn();
  autoLogin.handleText("\r\nPassword: ");

  assert.equal(completed, 0);
  assert.equal(incomplete, 0);
  assert.deepEqual(timers, []);
});

test("telnet auto-login keeps observing login prompts that arrive after expiry", () => {
  let clock = 0;
  let incomplete = 0;
  const writes = [];
  const autoLogin = createTelnetAutoLogin({
    username: "admin",
    password: "secret",
    write: (data) => writes.push(data),
    now: () => clock,
    timeoutMs: 60_000,
    onIncomplete: () => { incomplete += 1; },
  });

  // Slow-booting device: only a banner before the window expires, first
  // login prompt arrives afterwards.
  autoLogin.handleText("\r\nWelcome banner\r\n");
  clock = 60_001;
  autoLogin.handleText("\r\nUsername: ");
  autoLogin.handleText("\r\nPassword: ");

  // The pending prompt must be reported so the caller cancels its
  // deferred startup command; no credentials may be sent after expiry.
  assert.equal(incomplete, 1);
  assert.deepEqual(writes, []);
});
