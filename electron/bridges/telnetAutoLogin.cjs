const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_LIMIT = 2048;

const ANSI_PATTERN = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const LAST_LOGIN_PATTERN = /(?:^|[\s([])(?:last|previous)\s+login\s*[:：>]\s*$/i;
const USERNAME_PROMPT_PATTERN = /(?:^|[^A-Za-z0-9])(?:user\s*name|username|login|logon|account|userid|user\s*id|user|\u7528\u6237\u540d|\u5e10\u53f7|\u8d26\u53f7|\u767b\u5f55|\u767b\u5165)\s*[:：>]\s*$/i;
const PASSWORD_PROMPT_PATTERN = /(?:^|[^A-Za-z0-9])(?:password|passwd|passcode|passphrase|pass\s*phrase|pin|\u5bc6\u7801|\u53e3\u4ee4)\s*[:：>]\s*$/i;
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
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  let tail = "";
  let sentWake = false;
  let sentUsername = false;
  let sentPassword = false;
  let disabled = !hasCredentials;
  let completed = false;
  let userInputNotified = false;
  const startedAt = now();

  const isExpired = () => timeoutMs >= 0 && now() - startedAt > timeoutMs;
  const complete = () => {
    if (completed) return;
    completed = true;
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

  return {
    handleText(text) {
      if (disabled || isExpired()) {
        disabled = true;
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
    },
    handleUserInput() {
      disabled = true;
      notifyUserInput();
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
