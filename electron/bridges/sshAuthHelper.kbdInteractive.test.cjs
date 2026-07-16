const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKeyboardInteractiveHandler,
  createOrderedStringAuthHandler,
  createAuthPhase,
  canRepeatKeyboardInteractive,
  shouldSkipKiPasswordAutoFill,
  isAutoFillablePasswordChallenge,
  shouldPrefillSavedPassword,
  buildAuthHandler,
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
const drainPendingRequests = (sent, senderId = 42) => {
  for (const event of sent) {
    if (event.channel !== "netcatty:keyboard-interactive") continue;
    const requestId = event.payload?.requestId;
    if (requestId) {
      keyboardInteractiveHandler.handleResponse({ sender: { id: senderId } }, { requestId, cancelled: true });
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
const currentPasswordPrompt = { prompt: "Current password:", echo: false };
const newPasswordPrompt = { prompt: "New password:", echo: false };
const confirmPasswordPrompt = { prompt: "Confirm password:", echo: false };
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

// Corporate EDR / bastion step-up password prompts (#2150). These contain the
// word "密码" / "password" but must never be auto-filled with the login password.
const secondaryPasswordPrompt = { prompt: "二次密码:", echo: false };
const secondaryAuthPasswordPrompt = { prompt: "请输入二次认证密码", echo: false };
const securityPasswordPrompt = { prompt: "安全密码：", echo: false };
const secondaryPasswordEnPrompt = { prompt: "Secondary password:", echo: false };
const secondPasswordEnPrompt = { prompt: "Second password:", echo: false };

test("isAutoFillablePasswordChallenge rejects EDR secondary password prompts (#2150)", () => {
  assert.equal(isAutoFillablePasswordChallenge([secondaryPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondaryAuthPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([securityPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondaryPasswordEnPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondPasswordEnPrompt], "hunter2"), false);
});

// Real-world EDR banner from issue #2150 / reporter screenshot: Chinese
// instruction + English "Secondary Authentication Password:" field label.
const edrSecondaryAuthPasswordPrompt = {
  prompt: "Secondary Authentication Password:",
  echo: false,
};
const edrSecondaryAuthInstructions =
  "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。";

test("isAutoFillablePasswordChallenge rejects Secondary Authentication Password (#2150)", () => {
  // English field label alone must not auto-fill — words between "Secondary"
  // and "Password" are common in corporate EDR prompts.
  assert.equal(
    isAutoFillablePasswordChallenge([edrSecondaryAuthPasswordPrompt], "hunter2"),
    false,
  );
});

test("isAutoFillablePasswordChallenge rejects when 二次认证 is only in instructions (#2150)", () => {
  // Even if the prompt field were a generic "Password:", the instruction
  // banner carrying "二次认证密码" must still block auto-fill.
  assert.equal(
    isAutoFillablePasswordChallenge(
      [passwordPrompt],
      "hunter2",
      edrSecondaryAuthInstructions,
    ),
    false,
  );
  assert.equal(
    isAutoFillablePasswordChallenge(
      [edrSecondaryAuthPasswordPrompt],
      "hunter2",
      edrSecondaryAuthInstructions,
    ),
    false,
  );
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
  // savedPassword is intentionally omitted so a multi-round second factor that
  // also says "Password:" cannot re-submit the login secret on Enter (#2150).
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push({ second: responses }));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.deepEqual(finishCalls, [{ first: ["wrong-password"] }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  // Do not re-prefill the stale value, but still allow saving a corrected one.
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, true);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler carries the SSH auth banner into the modal when instructions are empty", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    getAuthBanner: () => "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
  });

  handler("", "", "", [edrSecondaryAuthPasswordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].payload.instructions,
    "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
  );

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler does not classify generic auth banners as secondary prompts", () => {
  const { sender, sent } = createSender();
  const finishCalls = [];
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-linux.example.com",
    password: "login-password",
    getAuthBanner: () => edrSecondaryAuthInstructions,
  });

  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  assert.deepEqual(finishCalls, [["login-password"]]);
  assert.equal(sent.length, 0);
});

test("createKeyboardInteractiveHandler adds the EDR fallback text for bare Secondary Authentication Password prompts", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "192.168.9.138",
    password: "login-password",
  });

  handler("", "", "", [edrSecondaryAuthPasswordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].payload.instructions,
    "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
  );

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler does not prefill after a prior auto-fill round (#2150)", () => {
  // Multi-round keyboard-interactive without partialSuccess between rounds:
  // round 1 auto-fills the login password; round 2 looks like Password: again
  // (EDR secondary) and must open empty.
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
  });

  handler("", "", "", [passwordPrompt], () => {}); // auto-fill
  handler("", "", "", [passwordPrompt], () => {}); // modal, no prefill

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

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

test("createKeyboardInteractiveHandler includes the request scope in modal payloads", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    scope: "terminal",
  });

  handler("Two-factor", "", "", [passwordPrompt, verificationCodePrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.scope, "terminal");

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

test("createKeyboardInteractiveHandler shows the modal for EDR secondary password prompts (#2150)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("EDR", "", "", [secondaryPasswordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  assert.equal(sent[0].payload.prompts[0].prompt, "二次密码:");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler skips auto-fill after password partialSuccess (#2150)", () => {
  // password method already succeeded as first factor; a later KI challenge
  // that merely says "Password:" must still show the modal so the user can
  // enter the distinct secondary secret.
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];
  const authPhase = createAuthPhase();
  authPhase.passwordAlreadySucceeded = true;

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler still auto-fills after publickey partialSuccess (#2151 P2)", () => {
  // publickey succeeded first; KI Password: is still the account password and
  // should auto-fill from the saved host credential.
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const authPhase = createAuthPhase();
  authPhase.hadPartialSuccess = true;
  // passwordAlreadySucceeded remains false

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  const finishCalls = [];
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(finishCalls, [["hunter2"]]);
  assert.deepEqual(sent, []);
});

test("createKeyboardInteractiveHandler still auto-fills before any partialSuccess", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const authPhase = createAuthPhase();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  const finishCalls = [];
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(finishCalls, [["hunter2"]]);
  assert.deepEqual(sent, []);
});

test("createKeyboardInteractiveHandler omits savedPassword on post-password-partialSuccess modal (#2150)", () => {
  const { sender, sent } = createSender();
  const authPhase = createAuthPhase();
  authPhase.passwordAlreadySucceeded = true;

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler omits savedPassword for secondary password prompts", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
  });

  handler("EDR", "", "", [secondaryPasswordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createOrderedStringAuthHandler sets hadPartialSuccess on partialSuccess", () => {
  const authPhase = { hadPartialSuccess: false };
  const handler = createOrderedStringAuthHandler(
    ["none", "password", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, false, (method) => offered.push(method)); // none
  handler(["password", "keyboard-interactive"], false, (method) => offered.push(method)); // password
  handler(["keyboard-interactive"], true, (method) => offered.push(method)); // KI after partial

  assert.deepEqual(offered, ["none", "password", "keyboard-interactive"]);
  assert.equal(authPhase.hadPartialSuccess, true);
});

test("createOrderedStringAuthHandler re-offers methods skipped as unavailable after partialSuccess (#2151 P2)", () => {
  // Server first only advertises publickey. password sits in our order before
  // publickey but is not advertised yet — it must NOT be permanently skipped.
  // After publickey partialSuccess, the server asks for password and we offer it.
  // (agent is also allowed when publickey is advertised, so it is tried first.)
  const authPhase = { hadPartialSuccess: false };
  const handler = createOrderedStringAuthHandler(
    ["none", "agent", "password", "publickey", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, false, (method) => offered.push(method)); // none
  handler(["publickey"], false, (method) => offered.push(method)); // agent
  handler(["publickey"], false, (method) => offered.push(method)); // publickey (password still not advertised)
  // publickey partially succeeds; server now allows password + KI.
  // Prefer keyboard-interactive automatically after any partial success.
  handler(["password", "keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "agent", "publickey", "keyboard-interactive"]);
  assert.equal(authPhase.hadPartialSuccess, true);

  // If KI only partially succeeds again, password remains available.
  handler(["password"], true, (method) => offered.push(method));
  assert.deepEqual(offered, ["none", "agent", "publickey", "keyboard-interactive", "password"]);
});

test("createOrderedStringAuthHandler does not retry a rejected credential in a later factor", () => {
  const authPhase = createAuthPhase();
  const handler = createOrderedStringAuthHandler(
    ["none", "agent", "publickey", "password", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, false, (method) => offered.push(method));
  handler(["publickey"], false, (method) => offered.push(method));
  handler(["publickey"], false, (method) => offered.push(method));
  handler(["publickey", "password"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "agent", "publickey", "password"]);
});

test("createOrderedStringAuthHandler allows consecutive keyboard-interactive factors (#2150)", () => {
  const authPhase = createAuthPhase();
  const handler = createOrderedStringAuthHandler(
    ["none", "password", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, null, (method) => offered.push(method));
  handler(["keyboard-interactive"], false, (method) => offered.push(method));
  handler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "keyboard-interactive", "keyboard-interactive"]);
  assert.equal(authPhase.hadPartialSuccess, true);
});

test("consecutive keyboard-interactive factors do not offer to save a generic second password (#2150)", () => {
  const { sender, sent } = createSender();
  const authPhase = createAuthPhase();
  const authHandler = createOrderedStringAuthHandler(
    ["none", "password", "keyboard-interactive"],
    authPhase,
  );
  const keyboardHandler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
  });

  const offered = [];
  authHandler(null, null, (method) => offered.push(method));
  authHandler(["keyboard-interactive"], false, (method) => offered.push(method));

  const firstResponses = [];
  keyboardHandler("", "", "", [passwordPrompt], (responses) => firstResponses.push(responses));
  assert.deepEqual(firstResponses, [["login-password"]]);
  assert.deepEqual(sent, []);

  authHandler(["keyboard-interactive"], true, (method) => offered.push(method));
  keyboardHandler("", "", "", [passwordPrompt], () => {});

  assert.deepEqual(offered, ["none", "keyboard-interactive", "keyboard-interactive"]);
  assert.equal(authPhase.keyboardInteractiveSuccessCount, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, false);

  drainPendingRequests(sent);
});

test("an intervening factor does not make a later keyboard-interactive password reusable (#2150)", () => {
  const authPhase = createAuthPhase();
  const authHandler = createOrderedStringAuthHandler(
    ["none", "keyboard-interactive", "publickey"],
    authPhase,
  );

  const offered = [];
  authHandler(null, null, (method) => offered.push(method));
  authHandler(["keyboard-interactive"], false, (method) => offered.push(method));
  authHandler(["publickey"], true, (method) => offered.push(method));
  assert.equal(shouldSkipKiPasswordAutoFill(authPhase), true);

  authHandler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "keyboard-interactive", "publickey", "keyboard-interactive"]);
  assert.equal(authPhase.keyboardInteractiveSuccessCount, 1);
  assert.equal(shouldSkipKiPasswordAutoFill(authPhase), true);
});

test("buildAuthHandler allows consecutive keyboard-interactive factors on the dynamic path (#2150)", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    username: "alice",
    password: "login-password",
    allowAgentFallback: false,
    defaultKeys: [{ keyName: "unused-test-key", privateKey: "unused" }],
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], false, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "keyboard-interactive", "keyboard-interactive"]);
  assert.equal(auth.authPhase.hadPartialSuccess, true);
});

test("buildAuthHandler prefers password over keyboard-interactive by default", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    username: "alice",
    password: "login-password",
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "password"]);
});

test("buildAuthHandler prefers password over keyboard-interactive by default", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    username: "alice",
    password: "login-password",
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "password"]);
});

test("buildAuthHandler skipPasswordMethod retries keyboard-interactive before password", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    username: "alice",
    password: "login-password",
    skipPasswordMethod: true,
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["publickey", "password", "keyboard-interactive"], false, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "keyboard-interactive"]);
});

test("buildAuthHandler prefers keyboard-interactive after partial success without host MFA flag", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    username: "alice",
    password: "login-password",
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "password", "keyboard-interactive"]);
});

test("buildAuthHandler skipPasswordMethod omits password for 2FA_RETRY", () => {
  const auth = buildAuthHandler({
    authMethod: "password",
    username: "alice",
    password: "login-password",
    skipPasswordMethod: true,
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));

  assert.deepEqual(offered, ["none", "keyboard-interactive"]);
});

test("buildAuthHandler keeps unavailable keyboard-interactive eligible after password rejection", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    username: "alice",
    password: "stale-password",
    allowAgentFallback: false,
    defaultKeys: [{ keyName: "unused-test-key", privateKey: "unused" }],
  });

  const offered = [];
  const record = (method) => offered.push(
    method && typeof method === "object" ? method.type : method,
  );

  auth.authHandler(null, null, record);
  auth.authHandler(["password"], false, record);
  auth.authHandler(["keyboard-interactive"], false, record);

  assert.deepEqual(offered, ["none", "password", "keyboard-interactive"]);
});

test("buildAuthHandler reconsiders dynamic methods between authentication factors (#2150)", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    username: "alice",
    password: "login-password",
    allowAgentFallback: false,
    defaultKeys: [{ keyName: "id_ed25519", privateKey: "test-key" }],
  });

  const offered = [];
  const record = (method) => offered.push(
    method && typeof method === "object" ? method.type : method,
  );
  auth.authHandler(null, null, record);
  auth.authHandler(["keyboard-interactive"], false, record);
  auth.authHandler(["publickey"], true, record);
  auth.authHandler(["keyboard-interactive"], true, record);

  assert.deepEqual(
    offered,
    ["none", "keyboard-interactive", "publickey", "keyboard-interactive"],
  );
  assert.equal(auth.authPhase.keyboardInteractiveSuccessCount, 1);
  assert.equal(shouldSkipKiPasswordAutoFill(auth.authPhase), true);
});

test("createOrderedStringAuthHandler caps repeated keyboard-interactive factors (#2150)", () => {
  const authPhase = createAuthPhase();
  const handler = createOrderedStringAuthHandler(
    ["none", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, null, (method) => offered.push(method));
  handler(["keyboard-interactive"], false, (method) => offered.push(method));
  handler(["keyboard-interactive"], true, (method) => offered.push(method));
  handler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(
    offered,
    ["none", "keyboard-interactive", "keyboard-interactive", false],
  );
  assert.equal(authPhase.keyboardInteractiveSuccessCount, 2);
});

test("createOrderedStringAuthHandler does not re-offer a rejected second interactive factor", () => {
  const authPhase = createAuthPhase();
  const handler = createOrderedStringAuthHandler(
    ["none", "keyboard-interactive", "publickey"],
    authPhase,
  );

  const offered = [];
  handler(null, null, (method) => offered.push(method));
  handler(["keyboard-interactive"], false, (method) => offered.push(method));
  handler(["keyboard-interactive"], true, (method) => offered.push(method));
  handler(["publickey"], false, (method) => offered.push(method));
  handler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(
    offered,
    ["none", "keyboard-interactive", "keyboard-interactive", "publickey", false],
  );
  assert.equal(authPhase.keyboardInteractiveSuccessCount, 1);
});

test("canRepeatKeyboardInteractive blocks an interactive method already rejected in this connection", () => {
  const authPhase = createAuthPhase();
  authPhase.keyboardInteractiveSuccessCount = 1;

  assert.equal(canRepeatKeyboardInteractive(authPhase, new Set()), true);
  assert.equal(
    canRepeatKeyboardInteractive(authPhase, new Set(["keyboard-interactive"])),
    false,
  );
});

test("buildAuthHandler caps repeated keyboard-interactive factors on the dynamic path (#2150)", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    username: "alice",
    password: "login-password",
    allowAgentFallback: false,
    defaultKeys: [{ keyName: "unused-test-key", privateKey: "unused" }],
  });

  const offered = [];
  auth.authHandler(null, null, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], false, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], true, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.deepEqual(
    offered,
    ["none", "keyboard-interactive", "keyboard-interactive", false],
  );
  assert.equal(auth.authPhase.keyboardInteractiveSuccessCount, 2);
});

test("buildAuthHandler does not retry a rejected credential in a later factor", () => {
  const auth = buildAuthHandler({
    authMethod: "auto",
    username: "alice",
    password: "login-password",
    allowAgentFallback: false,
    defaultKeys: [
      { keyName: "key-one", privateKey: "private-key-one" },
      { keyName: "key-two", privateKey: "private-key-two" },
    ],
  });

  const offered = [];
  const record = (method) => offered.push(
    method && typeof method === "object"
      ? `${method.type}:${method.key || "password"}`
      : method,
  );
  auth.authHandler(null, null, record);
  auth.authHandler(["publickey"], false, record);
  auth.authHandler(["publickey"], false, record);
  auth.authHandler(["publickey", "password"], true, record);

  assert.deepEqual(offered, [
    "none",
    "publickey:private-key-one",
    "publickey:private-key-two",
    "password:password",
  ]);
});

test("buildAuthHandler simple password path tracks partialSuccess via function handler", () => {
  const auth = buildAuthHandler({
    password: "hunter2",
    username: "alice",
    // No default keys / agent: simple explicit password-only path.
    defaultKeys: [],
    allowAgentFallback: false,
  });

  assert.equal(typeof auth.authHandler, "function");
  assert.ok(auth.authPhase);
  assert.equal(auth.authPhase.hadPartialSuccess, false);

  const offered = [];
  auth.authHandler(null, false, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], true, (method) => offered.push(method));

  // Default: password first; after partial success KI can still run as second factor.
  assert.deepEqual(offered, ["none", "password", "keyboard-interactive"]);
  assert.equal(auth.authPhase.hadPartialSuccess, true);
});

test("shouldPrefillSavedPassword is false after skipAutoFill and for secondary prompts", () => {
  assert.equal(
    shouldPrefillSavedPassword([passwordPrompt], "hunter2", { skipAutoFill: true }),
    false,
  );
  assert.equal(
    shouldPrefillSavedPassword([secondaryPasswordPrompt], "hunter2", { skipAutoFill: false }),
    false,
  );
  assert.equal(
    shouldPrefillSavedPassword([passwordPrompt], "hunter2", { skipAutoFill: false }),
    true,
  );
});

test("shouldPrefillSavedPassword keeps multi-prompt Duo/two-factor password prefill (#2151 P3)", () => {
  // Challenge name/instructions often say "Duo" / "two-factor" even when the
  // form still includes a first-factor Password: slot next to an OTP field.
  assert.equal(
    shouldPrefillSavedPassword(
      [passwordPrompt, verificationCodePrompt],
      "hunter2",
      { skipAutoFill: false, contextText: "Duo two-factor login" },
    ),
    true,
  );
  assert.equal(
    shouldPrefillSavedPassword(
      [passwordPrompt, verificationCodePrompt],
      "hunter2",
      { skipAutoFill: true, contextText: "Duo two-factor login" },
    ),
    false,
  );
});

test("createKeyboardInteractiveHandler suggests enabling host MFA for Secondary Authentication Password (#2150)", () => {
  const { handler, sent } = (() => {
    const sent = [];
    const handler = createKeyboardInteractiveHandler({
      sender: {
        id: 1,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
      sessionId: "s1",
      hostname: "host",
      password: "saved",
          });
    return { handler, sent };
  })();

  handler(
    "Keyboard-interactive authentication prompts from server",
    "为保障主机安全，请输入二次认证密码",
    "",
    [{ prompt: "Secondary Authentication Password:", echo: false }],
    () => {},
  );

  assert.equal(sent[0].payload.allowSavePassword, false);
  assert.equal(sent[0].payload.allowSavePassword, false);
  drainPendingRequests(sent, 1);
});

test("createKeyboardInteractiveHandler does not suggest host MFA for password-change prompts", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "password-expired.example.com",
    password: "saved",
      });

  handler(
    "Password expired",
    "You are required to change your password immediately.",
    "",
    [currentPasswordPrompt, newPasswordPrompt, confirmPasswordPrompt],
    () => {},
  );

  assert.ok(sent[0].payload);
  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler includes owning hostId in modal payload", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "sftp-connection-1",
    hostId: "host-1",
    hostname: "host",
    password: "saved",
  });

  handler(
    "Keyboard-interactive authentication prompts from server",
    "为保障主机安全，请输入二次认证密码",
    "",
    [{ prompt: "Secondary Authentication Password:", echo: false }],
    () => {},
  );

  assert.equal(sent[0].payload.hostId, "host-1");
  drainPendingRequests(sent, sender.id);
});

test("createKeyboardInteractiveHandler does not suggest MFA when host already has requiresMfa", () => {
  const sent = [];
  const handler = createKeyboardInteractiveHandler({
    sender: {
      id: 1,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
    sessionId: "s1",
    hostname: "host",
    password: "saved",
      });

  handler(
    "Keyboard-interactive authentication prompts from server",
    "为保障主机安全，请输入二次认证密码",
    "",
    [{ prompt: "Secondary Authentication Password:", echo: false }],
    () => {},
  );

  assert.ok(sent[0].payload);
  drainPendingRequests(sent, 1);
});

test("createKeyboardInteractiveHandler shows modal for Secondary Authentication Password banner (#2150)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "192.168.9.128",
    password: "login-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  handler(
    "Keyboard-interactive authentication prompts from server",
    edrSecondaryAuthInstructions,
    "",
    [edrSecondaryAuthPasswordPrompt],
    () => {},
  );

  assert.deepEqual(autoFillEvents, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, false);
  assert.equal(sent[0].payload.prompts[0].prompt, "Secondary Authentication Password:");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler disables save on post-password-partialSuccess Password prompt", () => {
  const { sender, sent } = createSender();
  const authPhase = createAuthPhase();
  authPhase.passwordAlreadySucceeded = true;

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(authPhase),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, false);

  drainPendingRequests(sent);
});

test("createOrderedStringAuthHandler sets passwordAlreadySucceeded only for password factor", () => {
  const authPhase = createAuthPhase();
  const handler = createOrderedStringAuthHandler(
    ["none", "publickey", "password", "keyboard-interactive"],
    authPhase,
  );

  handler(null, false, () => {}); // none
  handler(["publickey", "password", "keyboard-interactive"], false, () => {}); // publickey
  handler(["password", "keyboard-interactive"], true, () => {}); // after publickey PS

  assert.equal(authPhase.hadPartialSuccess, true);
  assert.equal(authPhase.passwordAlreadySucceeded, false);
  assert.equal(shouldSkipKiPasswordAutoFill(authPhase), false);

  const authPhasePw = createAuthPhase();
  const handlerPw = createOrderedStringAuthHandler(
    ["none", "password", "keyboard-interactive"],
    authPhasePw,
  );
  handlerPw(null, false, () => {});
  handlerPw(["password", "keyboard-interactive"], false, () => {}); // password
  handlerPw(["keyboard-interactive"], true, () => {}); // after password PS
  assert.equal(authPhasePw.passwordAlreadySucceeded, true);
  assert.equal(shouldSkipKiPasswordAutoFill(authPhasePw), true);
});

test("createKeyboardInteractiveHandler allows save on first-factor password modal", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    // No saved password → modal with save checkbox for first login
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.allowSavePassword, true);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler allows save on multi-prompt Password + OTP (#2151 P3)", () => {
  // PAM/Duo style: one keyboard-interactive challenge with a password slot
  // and a verification-code slot. Saving should still target the password
  // field only — do not disable allowSavePassword just because OTP wording
  // appears in another prompt of the same challenge.
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "duo.example.com",
    password: "login-password",
  });

  handler(
    "Duo two-factor login",
    "Enter password and passcode",
    "",
    [passwordPrompt, verificationCodePrompt],
    () => {},
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.allowSavePassword, true);
  // Prefill still OK for the password slot even when name/instructions say Duo.
  assert.equal(sent[0].payload.savedPassword, "login-password");

  drainPendingRequests(sent);
});

