const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_LIMIT = 2048;

const ANSI_PATTERN = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const LAST_LOGIN_PATTERN = /(?:^|[\s([])(?:last|previous)\s+login(?:\s*[:：>])?\s*$/i;
const USERNAME_PROMPT_PATTERN = /(?:^|[^A-Za-z0-9])(?:user\s*name|username|login|logon|account|userid|user\s*id|user|\u7528\u6237\u540d|\u5e10\u53f7|\u8d26\u53f7|\u767b\u5f55|\u767b\u5165)(?:\s*[:：>])?\s*$/i;
const PASSWORD_PROMPT_PATTERN = /(?:^|[^A-Za-z0-9])(?:password|passwd|passcode|passphrase|pass\s*phrase|pin|\u5bc6\u7801|\u53e3\u4ee4)(?:\s*[:：>])?\s*$/i;
const CONTINUE_PROMPT_PATTERN = /(?:press|hit)\s+(?:[<\[(]?\s*)?(?:return|enter|any\s+key|space)\b(?:\s*[>\]\)])?.*(?:continue|get\s+started|start|begin|started)?\.?\s*$/i;
const COMMAND_PROMPT_PATTERN = /[$#>]\s*$/;

function stripAnsi(text) {
  return String(text || "").replace(ANSI_PATTERN, "");
}

function normalizePromptTail(text) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

function lastPromptLine(text) {
  const normalized = normalizePromptTail(text);
  const lines = normalized.split("\n");
  return (lines[lines.length - 1] || "").slice(-320);
}

function promptLines(text) {
  return normalizePromptTail(text)
    .split("\n")
    .map((line) => line.slice(-320));
}

function isContinuePrompt(text) {
  const line = lastPromptLine(text);
  return CONTINUE_PROMPT_PATTERN.test(line);
}

function isUsernamePrompt(text) {
  const line = lastPromptLine(text);
  return !LAST_LOGIN_PATTERN.test(line) && USERNAME_PROMPT_PATTERN.test(line);
}

function isPasswordPrompt(text) {
  return PASSWORD_PROMPT_PATTERN.test(lastPromptLine(text));
}

function isCommandPrompt(text) {
  const line = lastPromptLine(text).trimEnd();
  if (!line || line.length > 200) return false;
  if (LAST_LOGIN_PATTERN.test(line)) return false;
  if (USERNAME_PROMPT_PATTERN.test(line)) return false;
  if (PASSWORD_PROMPT_PATTERN.test(line)) return false;
  if (CONTINUE_PROMPT_PATTERN.test(line)) return false;
  return COMMAND_PROMPT_PATTERN.test(line);
}

function hasUsernamePromptBeforePassword(text) {
  const lines = promptLines(text);
  const lastPasswordIndex = lines.findLastIndex((line) =>
    PASSWORD_PROMPT_PATTERN.test(line),
  );
  if (lastPasswordIndex < 0) return false;
  return lines
    .slice(0, lastPasswordIndex)
    .some((line) => !LAST_LOGIN_PATTERN.test(line) && USERNAME_PROMPT_PATTERN.test(line));
}

function normalizeUsername(username) {
  return typeof username === "string" ? username.trim() : "";
}

function normalizePassword(password) {
  return typeof password === "string" ? password : "";
}

function createTelnetAutoLogin(options = {}) {
  const username = normalizeUsername(options.username);
  const password = normalizePassword(options.password);
  const hasPassword = typeof options.password === "string";
  const hasCredentials = username.length > 0 || hasPassword;
  const write = typeof options.write === "function" ? options.write : () => {};
  const onComplete = typeof options.onComplete === "function" ? options.onComplete : () => {};
  const onUserInput = typeof options.onUserInput === "function" ? options.onUserInput : () => {};
  const onIncomplete = typeof options.onIncomplete === "function" ? options.onIncomplete : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : (id) => clearTimeout(id);

  let tail = "";
  let sentWake = false;
  let sentUsername = false;
  let sentPassword = false;
  let disabled = !hasCredentials;
  let completed = false;
  let userInputNotified = false;
  let incompleteNotified = false;
  let expiryTimer;
  const startedAt = now();

  const isExpired = () => timeoutMs >= 0 && now() - startedAt > timeoutMs;
  const clearExpiryTimer = () => {
    if (expiryTimer) {
      clearTimer(expiryTimer);
      expiryTimer = undefined;
    }
  };
  const complete = () => {
    if (completed) return;
    completed = true;
    clearExpiryTimer();
    onComplete();
  };
  const hasSentCredentials = () => sentPassword || sentUsername;
  const completeIfReady = () => {
    if (hasSentCredentials() && isCommandPrompt(tail)) {
      disabled = true;
      complete();
    }
  };
  const sendLine = (value) => {
    write(`${value}\r`);
  };
  const notifyUserInput = () => {
    if (userInputNotified) return;
    userInputNotified = true;
    onUserInput();
  };
  // The exchange stalled: credentials were sent but the device still sits at
  // a login/password prompt the detector cannot answer. Callers use this to
  // avoid blindly running post-login actions against the pending prompt.
  const notifyIncomplete = () => {
    if (incompleteNotified || completed) return;
    incompleteNotified = true;
    onIncomplete();
  };
  // The expiry must not depend on the device sending more bytes: a device
  // that rejects the saved credentials, reprints Login/Password and then goes
  // silent never triggers the handleText-after-expiry check below, so without
  // a timer the incomplete state is never reported and callers would blindly
  // type their startup command into the pending login prompt.
  const handleExpiry = () => {
    expiryTimer = undefined;
    if (completed || disabled) return;
    disabled = true;
    if (hasSentCredentials() && (isUsernamePrompt(tail) || isPasswordPrompt(tail))) {
      notifyIncomplete();
    }
  };
  if (timeoutMs >= 0) {
    expiryTimer = setTimer(handleExpiry, timeoutMs);
    // Do not keep the process alive just for this timer.
    expiryTimer?.unref?.();
  }

  return {
    handleText(text) {
      if (isExpired()) {
        disabled = true;
        // Keep observing output after expiry: a slow-booting device can
        // surface its first Login/Password prompt after the window elapsed
        // without any credentials having been sent. Report the pending
        // prompt so callers can cancel deferred post-login actions instead
        // of blindly typing them into it. Credentials are never sent here.
        tail = `${tail}${text || ""}`.slice(-TAIL_LIMIT);
        if (isUsernamePrompt(tail) || isPasswordPrompt(tail)) {
          notifyIncomplete();
        }
        return;
      }
      if (disabled) {
        return;
      }

      tail = `${tail}${text || ""}`.slice(-TAIL_LIMIT);
      completeIfReady();
      if (disabled) return;

      if (!sentWake && isContinuePrompt(tail)) {
        sentWake = true;
        sendLine("");
        return;
      }

      if (
        !sentUsername &&
        (username || hasPassword) &&
        (isUsernamePrompt(tail) || hasUsernamePromptBeforePassword(tail))
      ) {
        sentUsername = true;
        sendLine(username);
        completeIfReady();
      }

      if (!disabled && !sentPassword && hasPassword && isPasswordPrompt(tail)) {
        sentPassword = true;
        sendLine(password);
        completeIfReady();
      }

      // No password is configured but the device is now asking for one: the
      // exchange cannot proceed on its own. Report the stall so callers do
      // not schedule post-login actions that would be consumed as the
      // password. The detector stays enabled: if the device moves on to a
      // command prompt, completeIfReady can still fire.
      if (!disabled && !completed && !hasPassword && isPasswordPrompt(tail)) {
        notifyIncomplete();
      }
    },
    handleUserInput() {
      disabled = true;
      clearExpiryTimer();
      notifyUserInput();
    },
    // Tear down the detector without emitting anything: used when the owning
    // session is displaced by a reconnect, so the stale expiry timer can no
    // longer fire onIncomplete against the replacement session.
    cancel() {
      disabled = true;
      clearExpiryTimer();
    },
  };
}

module.exports = {
  createTelnetAutoLogin,
  isCommandPrompt,
  isContinuePrompt,
  isPasswordPrompt,
  isUsernamePrompt,
};
