/* eslint-disable no-undef */

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\"'\"'`)}'`;
}

const SUDO_PASSWORD_REQUIRED_RE =
  /sudo:\s*(a password is required|no password was provided|no tty present|a terminal is required)/i;
const SUDO_PASSWORD_INCORRECT_RE = /sorry, try again|incorrect password attempt/i;

/**
 * Classify sudo stderr/stdout from a scoped (other-user) command.
 * Returns "sudoPasswordRequired" | "sudoPasswordIncorrect" | null.
 */
function classifySudoError(text) {
  const msg = String(text || "");
  if (SUDO_PASSWORD_INCORRECT_RE.test(msg)) return "sudoPasswordIncorrect";
  if (SUDO_PASSWORD_REQUIRED_RE.test(msg)) return "sudoPasswordRequired";
  return null;
}

/**
 * Wrap a remote POSIX command line so it runs as another login user via sudo.
 * With a password, `sudo -S` reads it from stdin (never appears in argv or the
 * remote process list); without one, `sudo -n` fails fast instead of hanging
 * on a prompt, and the caller surfaces the classified error for prompting.
 */
function buildSudoUserCommand(script, user, password) {
  const target = String(user || "").trim();
  if (!target) return { command: script, stdin: undefined };
  const inner = `sh -c ${shQuote(script)}`;
  if (password) {
    return {
      command: `sudo -S -p '' -u ${shQuote(target)} -- ${inner}`,
      stdin: `${password}\n`,
    };
  }
  return { command: `sudo -n -u ${shQuote(target)} -- ${inner}`, stdin: undefined };
}

/**
 * Run `script` on the session, optionally scoped to another user via sudo.
 * Returns the raw exec result plus `errorCode` when sudo auth fails, so the
 * renderer can prompt for (and then persist) the host password.
 */
async function execScopedOnSession(execOnSession, event, sessionId, script, timeoutMs, scope) {
  const user = String(scope?.user || "").trim();
  if (!user) {
    return execOnSession(event, sessionId, script, timeoutMs);
  }
  const wrapped = buildSudoUserCommand(script, user, scope?.sudoPassword);
  const result = await execOnSession(event, sessionId, wrapped.command, timeoutMs, {
    stdin: wrapped.stdin,
  });
  const errorCode = classifySudoError(`${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.error || ""}`);
  if (errorCode) {
    return {
      success: false,
      error: (result?.stderr || result?.stdout || result?.error || "sudo authentication failed").trim(),
      errorCode,
      stdout: result?.stdout || "",
      stderr: result?.stderr || "",
      code: result?.code ?? 1,
    };
  }
  return result;
}

/**
 * Enumerate login users that can own tmux/zellij sessions. Single line: the
 * system-manager exec path wraps multi-line scripts badly through bash -lc.
 * Emits markers parsed by parseListUsersOutput.
 */
const MUX_LIST_USERS_SCRIPT = [
  'printf "%s\\n" "__NC_CURRENT_USER__=$(id -un 2>/dev/null || echo "$USER")"',
  'printf "%s\\n" "__NC_CURRENT_UID__=$(id -u 2>/dev/null || echo 0)"',
  'if command -v getent >/dev/null 2>&1; then getent passwd 2>/dev/null; elif [ -r /etc/passwd ]; then cat /etc/passwd 2>/dev/null; fi | while IFS=: read -r _nc_u _nc_x _nc_uid _nc_g _nc_gcos _nc_home _nc_shell; do case "$_nc_shell" in */nologin|*/false|"") continue;; esac; case "$_nc_uid" in ""|*[!0-9]*) continue;; esac; if [ "$_nc_uid" -eq 0 ] || [ "$_nc_uid" -ge 1000 ]; then printf "%s\\n" "__NC_USER__=$_nc_u:$_nc_uid"; fi; done',
  'if command -v dscl >/dev/null 2>&1 && ! command -v getent >/dev/null 2>&1; then dscl . -list /Users UniqueID 2>/dev/null | while read -r _nc_u _nc_uid; do case "$_nc_uid" in ""|*[!0-9-]*) continue;; esac; if [ "$_nc_uid" -eq 0 ] || [ "$_nc_uid" -ge 500 ]; then printf "%s\\n" "__NC_USER__=$_nc_u:$_nc_uid"; fi; done; fi',
  'for _nc_d in /tmp/tmux-*; do [ -d "$_nc_d" ] || continue; _nc_tuid="${_nc_d##*/tmux-}"; case "$_nc_tuid" in ""|*[!0-9]*) continue;; esac; printf "%s\\n" "__NC_TMUX_UID__=$_nc_tuid"; done',
].join("; ");

function parseListUsersOutput(stdout) {
  const users = new Map();
  const tmuxUids = new Set();
  let currentUser = "";
  let currentUid = 0;

  for (const rawLine of String(stdout || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("__NC_CURRENT_USER__=")) {
      currentUser = line.slice("__NC_CURRENT_USER__=".length).trim();
      continue;
    }
    if (line.startsWith("__NC_CURRENT_UID__=")) {
      currentUid = Number(line.slice("__NC_CURRENT_UID__=".length)) || 0;
      continue;
    }
    if (line.startsWith("__NC_TMUX_UID__=")) {
      const uid = Number(line.slice("__NC_TMUX_UID__=".length));
      if (Number.isFinite(uid)) tmuxUids.add(uid);
      continue;
    }
    if (line.startsWith("__NC_USER__=")) {
      const body = line.slice("__NC_USER__=".length);
      const sep = body.lastIndexOf(":");
      if (sep <= 0) continue;
      const name = body.slice(0, sep).trim();
      const uid = Number(body.slice(sep + 1));
      if (!name || !Number.isFinite(uid)) continue;
      if (!users.has(name)) users.set(name, { name, uid, hasTmuxSockets: false });
    }
  }

  const list = [...users.values()].map((user) => ({
    ...user,
    hasTmuxSockets: tmuxUids.has(user.uid),
  }));
  return { currentUser, currentUid, users: list };
}

module.exports = {
  buildSudoUserCommand,
  classifySudoError,
  execScopedOnSession,
  MUX_LIST_USERS_SCRIPT,
  parseListUsersOutput,
  shQuote,
};
