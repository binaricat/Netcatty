const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKeyboardInteractiveHandler,
  isAutoFillablePasswordChallenge,
} = require("./sshAuthHelper.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");

const createSender = () => {
  const sent = [];
  return {
    sent,
    sender: {
      id: 42,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
};

// Settles any modal requests that the handler queued via storeRequest so the
// 5-minute TTL timer doesn't keep the test process alive.
const drainPendingRequests = (sent) => {
  for (const event of sent) {
    if (event.channel !== "netcatty:keyboard-interactive") continue;
    const requestId = event.payload?.requestId;
    if (requestId) {
      keyboardInteractiveHandler.handleResponse(null, { requestId, cancelled: true });
    }
  }
};

const passwordPrompt = { prompt: "Password:", echo: false };
const linuxPasswordPrompt = { prompt: "[sudo] password for alice:", echo: false };
const verificationCodePrompt = { prompt: "Verification code:", echo: true };
const otpPrompt = { prompt: "Verification code:", echo: false }; // Google Auth / TOTP
const duoPrompt = { prompt: "Duo two-factor login\nPasscode or option (1-1):", echo: false };
const cjkPasswordPrompt = { prompt: "密码：", echo: false };
const customizedAuthPrompt = { prompt: "Please authenticate:", echo: false };
// OTP prompts that DO mention the word "password" or "口令" — the literal
// keyword should not be enough to trigger auto-fill (#969 PR review round 2).
const oneTimePasswordPrompt = { prompt: "Enter your one-time password:", echo: false };
const cjkDynamicPasswordPrompt = { prompt: "动态密码：", echo: false };
const cjkDynamicTokenPrompt = { prompt: "动态口令：", echo: false };
const cjkOneTimePasswordPrompt = { prompt: "一次性密码：", echo: false };

// --- isAutoFillablePasswordChallenge ---------------------------------------

test("isAutoFillablePasswordChallenge accepts a single hidden-echo prompt with a saved password", () => {
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], "hunter2"), true);
});

test("isAutoFillablePasswordChallenge rejects multi-prompt challenges (likely 2FA)", () => {
  assert.equal(
    isAutoFillablePasswordChallenge([passwordPrompt, verificationCodePrompt], "hunter2"),
    false,
  );
});

test("isAutoFillablePasswordChallenge rejects echo=true prompts (could be username / OTP)", () => {
  assert.equal(isAutoFillablePasswordChallenge([verificationCodePrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects when no saved password is available", () => {
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], ""), false);
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], undefined), false);
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], null), false);
});

test("isAutoFillablePasswordChallenge rejects empty / non-array prompts", () => {
  assert.equal(isAutoFillablePasswordChallenge([], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge(undefined, "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects OTP-style hidden prompts (Google Authenticator, TOTP)", () => {
  // Single prompt, echo=false, but the text says "Verification code" — that's
  // a 2FA challenge, not a password. Submitting the saved password here would
  // burn an auth attempt on the server. (#969 PR review)
  assert.equal(isAutoFillablePasswordChallenge([otpPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects Duo-style passcode prompts", () => {
  // "Passcode" is the term Duo uses for the OTP, not a reusable password.
  // Treat it as a 2FA challenge.
  assert.equal(isAutoFillablePasswordChallenge([duoPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge accepts CJK password prompts", () => {
  // PAM on Chinese-locale Linux often renders "密码：" — the user still
  // expects the saved password to work.
  assert.equal(isAutoFillablePasswordChallenge([cjkPasswordPrompt], "hunter2"), true);
});

test("isAutoFillablePasswordChallenge falls through to the modal for unrecognized prompt text", () => {
  // Custom prompts that don't mention a known keyword stay on the safe side
  // — the user sees the modal as before. No regression from the old
  // always-prompt baseline.
  assert.equal(isAutoFillablePasswordChallenge([customizedAuthPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects 'One-time password' even though it contains the word 'password'", () => {
  // PR review round 2: the OTP vocabulary check must run before the password
  // keyword check, otherwise "password" in "One-time password" triggers a
  // false-positive auto-fill that burns a 2FA attempt.
  assert.equal(isAutoFillablePasswordChallenge([oneTimePasswordPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects Chinese OTP prompts ('动态密码', '动态口令', '一次性密码')", () => {
  // The Chinese "动态密码" / "动态口令" / "一次性密码" idioms specifically
  // mean OTP. Mustn't auto-fill the reusable password into them.
  assert.equal(isAutoFillablePasswordChallenge([cjkDynamicPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([cjkDynamicTokenPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([cjkOneTimePasswordPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge accepts a sudo-style password prompt", () => {
  // Regression guard: the OTP deny-list should not over-block normal Linux
  // PAM prompts that legitimately mention a username after "password".
  assert.equal(isAutoFillablePasswordChallenge([linuxPasswordPrompt], "hunter2"), true);
});

// --- createKeyboardInteractiveHandler --------------------------------------

test("createKeyboardInteractiveHandler auto-fills the saved password for a single password prompt", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  // The handler answered without sending any IPC and without showing a prompt.
  assert.deepEqual(sent, []);
  assert.deepEqual(promptEvents, []);
  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(finishCalls, [["hunter2"]]);
});

test("createKeyboardInteractiveHandler falls back to the modal on the retry after a failed auto-fill", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "wrong-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  // First call — auto-fill fires, no modal shown.
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push({ first: responses }));
  // ssh2 re-invokes after auth failure — this time the user must see the modal.
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push({ second: responses }));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.deepEqual(finishCalls, [{ first: ["wrong-password"] }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler shows the modal when the challenge is real 2FA (multiple prompts)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("Two-factor", "", "", [passwordPrompt, verificationCodePrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.prompts.length, 2);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler does not auto-fill when no saved password is configured", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: undefined,
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler shows the modal for OTP-style hidden prompts even with a saved password", () => {
  // Regression guard for the #969 PR review: a single hidden-echo prompt
  // that doesn't mention "password" must not auto-submit the saved value.
  const { sender, sent } = createSender();
  const autoFillEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  handler("", "", "", [otpPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.equal(sent.length, 1, "modal IPC should fire instead of auto-fill");
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler short-circuits when the server sends zero prompts", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  handler("", "", "", [], (responses) => finishCalls.push(responses));

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(finishCalls, [[]]);
});
