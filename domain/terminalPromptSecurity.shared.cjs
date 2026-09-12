"use strict";

const ESCAPE_SEQUENCE = "\\x" + "1b";
const BELL_SEQUENCE = "\\x" + "07";
const ANSI_CONTROL_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[[0-?]*[ -/]*[@-~]`, "gu");
const OSC_CONTROL_PATTERN = new RegExp(
  `${ESCAPE_SEQUENCE}\\][^${BELL_SEQUENCE}]*(?:${BELL_SEQUENCE}|${ESCAPE_SEQUENCE}\\\\)`,
  "gu",
);
const MAX_PROMPT_SECURITY_TAIL_CHARS = 2_048;

const SENSITIVE_ENGLISH_LABEL = [
  String.raw`pass(?:word|phrase|code)`,
  String.raw`one[\s-]?time(?:\s+(?:password|passcode|code|token))?`,
  String.raw`\botp\b`,
  String.raw`verification(?:\s+(?:code|token|passcode))?`,
  String.raw`authentication\s+(?:code|token|passcode)`,
  String.raw`security\s+(?:code|token|passcode|pin)`,
  String.raw`\bpin\b`,
  String.raw`\btoken\b`,
  String.raw`2fa`,
  String.raw`two[\s-]?factor`,
  String.raw`multi[\s-]?factor`,
  String.raw`\bmfa\b`,
  String.raw`second\s+factor`,
  String.raw`secondary(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`second(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`additional(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`re[-\s]?enter\s+passw(?:ord)?`,
  String.raw`confirm\s+passw(?:ord)?`,
  String.raw`\bedr\b`,
  String.raw`\bduo\b`,
].join("|");

const SENSITIVE_CJK_LABEL = [
  "密码", "口令", "动态", "一次性", "验证码", "验证信息", "令牌", "双因素", "多因素",
  "短信验证", "手机验证", "二次", "安全密码", "挑战码",
].join("|");

const SENSITIVE_LABEL_PATTERN = new RegExp(
  `(?:${SENSITIVE_ENGLISH_LABEL}|${SENSITIVE_CJK_LABEL})`,
  "iu",
);

function stripTerminalControlSequences(value) {
  return String(value || "").replace(OSC_CONTROL_PATTERN, "").replace(ANSI_CONTROL_PATTERN, "");
}

function lastLogicalLine(value) {
  const plain = stripTerminalControlSequences(value);
  const boundary = Math.max(plain.lastIndexOf("\n"), plain.lastIndexOf("\r"));
  return plain.slice(boundary + 1).slice(-MAX_PROMPT_SECURITY_TAIL_CHARS);
}

function isSensitiveTerminalChallenge(value) {
  const line = lastLogicalLine(value).trim();
  if (!line) return false;
  const label = SENSITIVE_LABEL_PATTERN.exec(line);
  if (!label) return false;
  const prefix = line.slice(0, label.index || 0).trim();
  const suffix = line.slice((label.index || 0) + label[0].length);
  if (suffix.trim().length === 0) {
    return prefix.length === 0
      || /(?:^|\s)(?:enter|input|provide|type|scan|please|your|current|new|old)\s*$/iu.test(prefix)
      || /(?:输入|请输入|请)\s*$/u.test(prefix);
  }
  if (/^\s+(?:for|of)\s+[^\r\n]{1,96}$/iu.test(suffix)) return true;
  return /^[^\r\n:：>›»]{0,96}[:：>›»]\s*[^\r\n]{0,1024}$/u.test(suffix);
}

function isConfirmedTerminalShellPrompt(promptText, options = {}) {
  const prompt = lastLogicalLine(promptText).trim();
  if (!prompt || isSensitiveTerminalChallenge(prompt)) return false;
  if (/[❯❮→➜➤⟩»›]/u.test(prompt)) return true;
  for (const character of prompt) {
    const code = character.charCodeAt(0);
    if (code >= 0xE000 && code <= 0xF8FF) return true;
  }
  if (/[$#%]$/u.test(prompt)) return true;
  if (!prompt.endsWith(">")) return false;
  if (/^(?:PS\s+)?[A-Za-z]:[\\/].*>$/u.test(prompt)) return true;
  if (/[@\\/~:]\S*>$/u.test(prompt)) return true;
  return options.allowHostStyleGreaterThan === true
    && /^[A-Za-z0-9_.-]+(?:\([^)]{1,128}\))?>$/u.test(prompt);
}

function isPlausibleShellPromptBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return true;
  if (/@|[/\\~:]/u.test(trimmed)) return true;
  if (/^(?:bash|zsh|sh|fish|ksh|csh|tcsh|dash)(?:-[\d.]+)?$/iu.test(trimmed)) return true;
  return /^[a-z0-9_.-]+$/u.test(trimmed);
}

function hasTypedInputAfterConfirmedPrompt(line, options = {}) {
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i];
    if (ch !== "$" && ch !== "#" && ch !== "%" && ch !== ">") continue;
    const rest = line.slice(i + 1);
    if (!/^\s+\S/u.test(rest)) continue;
    const candidate = line.slice(0, i + 1);
    if (!isConfirmedTerminalShellPrompt(candidate, options)) continue;
    if ((ch === "$" || ch === "#" || ch === "%") && !isPlausibleShellPromptBody(candidate.slice(0, -1))) {
      continue;
    }
    return true;
  }
  return false;
}

function isUntrustedTerminalInputPrompt(value, options = {}) {
  const prompt = lastLogicalLine(value).trim();
  if (!prompt) return false;
  if (isSensitiveTerminalChallenge(prompt)) return true;
  if (!/[:：>›»]\s*$/u.test(prompt)) return false;
  if (hasTypedInputAfterConfirmedPrompt(prompt, options)) return false;
  return !isConfirmedTerminalShellPrompt(prompt, options);
}

module.exports = { isUntrustedTerminalInputPrompt };
