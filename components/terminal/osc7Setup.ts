export const OSC7_MARKER = "Netcatty OSC 7 cwd tracking";

export const OSC7_SETUP_TARGETS = [
  "~/.bashrc",
  "${ZDOTDIR:-~}/.zshrc",
  "~/.config/fish/config.fish",
] as const;

export const OSC7_SETUP_SHELL_MARKER = "__NETCATTY_OSC7_SETUP_SHELL__=";
export const OSC7_SETUP_CONFIG_MARKER = "__NETCATTY_OSC7_SETUP_CONFIG__=";

export type Osc7SetupActionContext = {
  protocol?: string;
  isLocalConnection?: boolean;
  isSerialConnection?: boolean;
  isNetworkDevice?: boolean;
};

export type Osc7SetupShell = "bash" | "zsh" | "fish";

export type Osc7SetupMetadata = {
  shell: Osc7SetupShell;
  configPath: string;
};

export type Osc7SetupRunResult = {
  success: boolean;
  pending?: boolean;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
  reloadCommand?: string;
};

export type RunOsc7SetupActionOptions = {
  status: string;
  sessionId: string;
  setupCommand: string;
  setupOsc7Tracking?: (
    sessionId: string,
    command: string,
  ) => Promise<Osc7SetupRunResult>;
  writeToSession: (
    sessionId: string,
    data: string,
    options?: {
      automated?: boolean;
      logRewrite?: { sentCommand: string; displayCommand: string };
    },
  ) => void;
  writeLocalTerminalData?: (data: string) => void;
};

export const shouldOfferOsc7SetupAction = ({
  protocol,
  isLocalConnection,
  isSerialConnection,
  isNetworkDevice,
}: Osc7SetupActionContext): boolean =>
  !isLocalConnection
  && !isSerialConnection
  && !isNetworkDevice
  && protocol !== "telnet";

const DOLLAR = "$";

const URL_PATH_AWK_SCRIPT = String.raw`BEGIN {
  for (i = 0; i < 256; i++) {
    c = sprintf("%c", i)
    ord[c] = i
  }
}
{
  if (NR > 1) encode("\n")
  for (i = 1; i <= length($0); i++) {
    encode(substr($0, i, 1))
  }
}
function encode(c, o) {
  o = ord[c]
  if ((o >= 48 && o <= 57) || (o >= 65 && o <= 90) || (o >= 97 && o <= 122) || c == "/" || c == "-" || c == "." || c == "_" || c == "~") {
    printf "%s", c
  } else {
    printf "%%%02X", o
  }
}`;

const quoteForSingleQuotedShellString = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const URL_PATH_AWK_SCRIPT_QUOTED = quoteForSingleQuotedShellString(URL_PATH_AWK_SCRIPT);

const BASH_DELETE_MARKED_HISTORY_COMMAND = String.raw`if test -n "${DOLLAR}{BASH_VERSION-}"; then __netcatty_osc7_history_cleanup_marker__=1; __netcatty_osc7_history_line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null) || __netcatty_osc7_history_line=""; case "$__netcatty_osc7_history_line" in *__netcatty_osc7_history_cleanup_marker__=1*) __netcatty_osc7_history_number=$(printf "%s\n" "$__netcatty_osc7_history_line" | sed "s/^ *\([0-9][0-9]*\).*/\1/"); case "$__netcatty_osc7_history_number" in ""|*[!0-9]*) ;; *) builtin history -d "$__netcatty_osc7_history_number" 2>/dev/null || true;; esac;; esac; unset __netcatty_osc7_history_cleanup_marker__ __netcatty_osc7_history_line __netcatty_osc7_history_number 2>/dev/null || true; fi`;

const POSIX_SETUP_SCRIPT = String.raw`set -eu
marker="# >>> Netcatty OSC 7 cwd tracking >>>"
SELF=$$
expected_cwd="${DOLLAR}{NETCATTY_OSC7_EXPECTED_CWD:-}"

find_login_shell() {
  _shell=$(ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null | awk -v pp="$1" -v self="$SELF" '
    $1 != self && $2 == pp && $4 ~ /^-?(ba|z|fi|k|da|a)?sh$/ {
      if ($3 != "?") { print $1; found=1; exit }
      if (any == "") any=$1
    }
    END { if (!found && any != "") print any }
  ')
  [ -n "$_shell" ] && { echo "$_shell"; return; }
  [ -r "/proc/$SELF/environ" ] || return
  _conn=$(tr '\0' '\n' < "/proc/$SELF/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
  [ -z "$_conn" ] && return
  _any=""
  for _d in /proc/[0-9]*; do
    _pid=$(basename "$_d")
    [ "$_pid" = "$SELF" ] && continue
    [ -r "$_d/environ" ] || continue
    _conn2=$(tr '\0' '\n' < "$_d/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
    [ "$_conn2" = "$_conn" ] || continue
    _comm=$(cat "$_d/comm" 2>/dev/null)
    case "$_comm" in
      sh|bash|zsh|fish|ksh|dash|ash) ;;
      *) continue ;;
    esac
    _tty=$(ps -p "$_pid" -o tty= 2>/dev/null | tr -d '[:space:]')
    if [ "$_tty" != "?" ] && [ -n "$_tty" ]; then
      echo "$_pid"
      return
    fi
    [ -z "$_any" ] && _any="$_pid"
  done
  [ -n "$_any" ] && echo "$_any"
}

find_active_shell() {
  ps -e -o pid=,ppid=,stat=,comm= 2>/dev/null | awk -v start="$1" '
    { pp[$1]=$2; st[$1]=$3; cm[$1]=$4; ord[NR]=$1 }
    function isshell(c) { return c ~ /^-?(ba|z|fi|k|da|a)?sh$/ }
    function depth(p,   d) { d=0; while (p != "" && d < 64) { if (p == start) return d; p=pp[p]; d++ } return -1 }
    END {
      best=-1; bp="";
      for (i=1; i<=NR; i++) {
        p=ord[i];
        if (!isshell(cm[p])) continue;
        if (index(st[p], "+") == 0) continue;
        d=depth(p); if (d < 0) continue;
        if (d > best) { best=d; bp=p }
      }
      print (bp != "" ? bp : start)
    }
  '
}

read_proc_env_value() {
  [ -r "$1" ] || return 1
  tr '\0' '\n' < "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -n1
}

active_shell_pid=""
login_shell_pid=""
if [ -d /proc ]; then
  login_shell_pid=$(find_login_shell "$PPID" || true)
  if [ -n "$login_shell_pid" ]; then
    active_shell_pid=$(find_active_shell "$login_shell_pid" || true)
    [ -n "$active_shell_pid" ] || active_shell_pid="$login_shell_pid"
  fi
fi

if [ -d /proc ] && [ -n "$expected_cwd" ]; then
  if [ -z "$active_shell_pid" ]; then
    printf "Netcatty OSC 7 setup: could not identify the active terminal shell\n" >&2
    exit 4
  fi
  active_cwd=$(readlink "/proc/$active_shell_pid/cwd" 2>/dev/null || true)
  if [ "$active_cwd" != "$expected_cwd" ]; then
    printf "Netcatty OSC 7 setup: active terminal shell did not match the current tab\n" >&2
    exit 4
  fi
fi

active_comm=""
active_home=""
active_shell_env=""
active_zdotdir=""
active_xdg_config_home=""
if [ -n "$active_shell_pid" ]; then
  active_comm=$(cat "/proc/$active_shell_pid/comm" 2>/dev/null | sed "s/^-//" | tr -d "[:space:]")
  active_env_file="/proc/$active_shell_pid/environ"
  if [ -r "$active_env_file" ]; then
    active_home=$(read_proc_env_value "$active_env_file" HOME || true)
    active_shell_env=$(read_proc_env_value "$active_env_file" SHELL || true)
    active_zdotdir=$(read_proc_env_value "$active_env_file" ZDOTDIR || true)
    active_xdg_config_home=$(read_proc_env_value "$active_env_file" XDG_CONFIG_HOME || true)
  elif [ "$active_shell_pid" != "$login_shell_pid" ]; then
    printf "Netcatty OSC 7 setup: cannot silently configure an active shell owned by another user\n" >&2
    exit 3
  fi
fi

parent_shell=$(ps -p "$PPID" -o comm= 2>/dev/null | sed "s/^-//" | tr -d "[:space:]")
login_shell=$(basename "${DOLLAR}{active_shell_env:-${DOLLAR}{SHELL:-sh}}" | sed "s/^-//")
shell_name="$login_shell"
case "$parent_shell" in
  bash|zsh|fish) shell_name="$parent_shell" ;;
esac
case "$active_comm" in
  bash|zsh|fish) shell_name="$active_comm" ;;
esac

home_dir="${DOLLAR}{active_home:-$HOME}"
zdotdir="${DOLLAR}{active_zdotdir:-${DOLLAR}{NETCATTY_ZDOTDIR:-${DOLLAR}{ZDOTDIR:-$home_dir}}}"
xdg_config_home="${DOLLAR}{active_xdg_config_home:-${DOLLAR}{NETCATTY_XDG_CONFIG_HOME:-${DOLLAR}{XDG_CONFIG_HOME:-$home_dir/.config}}}"

case "$shell_name" in
  bash) config="$home_dir/.bashrc" ;;
  zsh) config="$zdotdir/.zshrc" ;;
  fish) config="$xdg_config_home/fish/config.fish" ;;
  *)
    printf "Netcatty OSC 7 setup: unsupported shell %s\n" "$shell_name" >&2
    printf "Supported shells: bash, zsh, fish\n" >&2
    exit 2
    ;;
esac

__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk ${URL_PATH_AWK_SCRIPT_QUOTED}
}

mkdir -p "$(dirname "$config")"
touch "$config"
if grep -F "$marker" "$config" >/dev/null 2>&1; then
  :
else
  case "$shell_name" in
    bash)
      cat >> "$config" <<'NETCATTY_OSC7_BASH'

# >>> Netcatty OSC 7 cwd tracking >>>
__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
}
osc7_cwd() {
  printf '\033]7;file://%s%s\a' "${DOLLAR}{HOSTNAME:-localhost}" "$(__netcatty_osc7_url_path "$PWD")"
}
case "${DOLLAR}{PROMPT_COMMAND:-}" in
  *osc7_cwd*) ;;
  *)
    if [ -n "${DOLLAR}{PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="${DOLLAR}{PROMPT_COMMAND}
osc7_cwd"
    else
      PROMPT_COMMAND="osc7_cwd"
    fi
    ;;
esac
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_BASH
      ;;
    zsh)
      cat >> "$config" <<'NETCATTY_OSC7_ZSH'

# >>> Netcatty OSC 7 cwd tracking >>>
__netcatty_osc7_url_path() {
  printf "%s" "$1" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
}
osc7_cwd() {
  printf '\033]7;file://%s%s\a' "${DOLLAR}{HOST:-${DOLLAR}{HOSTNAME:-localhost}}" "$(__netcatty_osc7_url_path "$PWD")"
}
if (( ${DOLLAR}{+precmd_functions} )); then
  case " ${DOLLAR}{precmd_functions[*]} " in
    *" osc7_cwd "*) ;;
    *) precmd_functions+=(osc7_cwd) ;;
  esac
else
  precmd_functions=(osc7_cwd)
fi
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_ZSH
      ;;
    fish)
      cat >> "$config" <<'NETCATTY_OSC7_FISH'

# >>> Netcatty OSC 7 cwd tracking >>>
function __netcatty_osc7_url_path
    printf "%s" "$argv[1]" | LC_ALL=C awk '${URL_PATH_AWK_SCRIPT}'
end
function __netcatty_osc7_cwd --on-event fish_prompt
    printf '\033]7;file://%s%s\a' (hostname 2>/dev/null; or printf localhost) (__netcatty_osc7_url_path "$PWD")
end
# <<< Netcatty OSC 7 cwd tracking <<<
NETCATTY_OSC7_FISH
      ;;
  esac
fi

printf '%s%s\n' '${OSC7_SETUP_SHELL_MARKER}' "$shell_name"
printf '%s%s\n' '${OSC7_SETUP_CONFIG_MARKER}' "$config"
host=$(hostname 2>/dev/null || printf localhost)
printf '\033]7;file://%s%s\a' "$host" "$(__netcatty_osc7_url_path "$PWD")"`;

export const buildOsc7SetupCommand = (): string =>
  `set +u 2>/dev/null || true; printf "%s\\n" ${quoteForSingleQuotedShellString(POSIX_SETUP_SCRIPT)} | env NETCATTY_ZDOTDIR="$ZDOTDIR" NETCATTY_XDG_CONFIG_HOME="$XDG_CONFIG_HOME" sh\n`;

export const buildOsc7SetupExecCommand = (expectedCwd?: string): string => {
  const envPrefix = expectedCwd
    ? `env NETCATTY_OSC7_EXPECTED_CWD=${quoteForSingleQuotedShellString(expectedCwd)} `
    : "";
  return `exec ${envPrefix}sh -c ${quoteForSingleQuotedShellString(POSIX_SETUP_SCRIPT)}\n`;
};

const isOsc7SetupShell = (value: string): value is Osc7SetupShell =>
  value === "bash" || value === "zsh" || value === "fish";

const readMarkerLine = (stdout: string, marker: string): string | null => {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  return line ? line.slice(marker.length).trim() : null;
};

export const parseOsc7SetupMetadata = (stdout: string): Osc7SetupMetadata | null => {
  const shell = readMarkerLine(stdout, OSC7_SETUP_SHELL_MARKER);
  const configPath = readMarkerLine(stdout, OSC7_SETUP_CONFIG_MARKER);
  if (!shell || !isOsc7SetupShell(shell) || !configPath) return null;
  return { shell, configPath };
};

export const extractOsc7SetupTerminalData = (stdout: string): string => {
  const escape = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  const prefix = `${escape}]7;`;
  let offset = 0;
  let output = "";

  while (offset < stdout.length) {
    const start = stdout.indexOf(prefix, offset);
    if (start < 0) break;
    const bodyStart = start + prefix.length;
    const bellEnd = stdout.indexOf(bell, bodyStart);
    const stEnd = stdout.indexOf(`${escape}\\`, bodyStart);
    const hasBellEnd = bellEnd >= 0;
    const hasStEnd = stEnd >= 0;
    if (!hasBellEnd && !hasStEnd) break;

    const useBell = hasBellEnd && (!hasStEnd || bellEnd < stEnd);
    const end = useBell ? bellEnd : stEnd;
    const terminatorLength = useBell ? 1 : 2;
    output += stdout.slice(start, end + terminatorLength);
    offset = end + terminatorLength;
  }

  return output;
};

export const buildOsc7ReloadCommand = (metadata: Osc7SetupMetadata | null): string | null => {
  if (!metadata) return null;
  const sourceCommand = `source ${quoteForSingleQuotedShellString(metadata.configPath)} >/dev/null 2>&1`;
  const emitCommand = metadata.shell === "fish" ? "__netcatty_osc7_cwd" : "osc7_cwd";
  if (metadata.shell === "bash") {
    return `${sourceCommand}; ${emitCommand} 2>/dev/null; true; ${BASH_DELETE_MARKED_HISTORY_COMMAND}\r`;
  }
  return ` ${sourceCommand}; ${emitCommand} 2>/dev/null; true\r`;
};

export const runOsc7SetupAction = async ({
  status,
  sessionId,
  setupCommand,
  setupOsc7Tracking,
  writeToSession,
  writeLocalTerminalData,
}: RunOsc7SetupActionOptions): Promise<Osc7SetupRunResult> => {
  if (status !== "connected") {
    return { success: false, error: "Terminal is not connected" };
  }
  if (!setupOsc7Tracking) {
    return { success: false, error: "Directory tracking setup is unavailable" };
  }

  const result = await setupOsc7Tracking(sessionId, setupCommand);
  if (!result.success || (typeof result.code === "number" && result.code !== 0)) {
    return {
      ...result,
      success: false,
      error: result.error || result.stderr?.trim() || "Directory tracking setup failed",
    };
  }

  const metadata = parseOsc7SetupMetadata(result.stdout || "");
  const reloadCommand = buildOsc7ReloadCommand(metadata);
  if (!reloadCommand) {
    return {
      ...result,
      success: false,
      error: "Directory tracking setup did not return reload metadata",
    };
  }

  const terminalData = extractOsc7SetupTerminalData(result.stdout || "");
  if (terminalData) {
    writeLocalTerminalData?.(terminalData);
  }
  writeToSession(sessionId, reloadCommand, {
    automated: true,
    logRewrite: { sentCommand: reloadCommand, displayCommand: "" },
  });

  return { ...result, success: true, reloadCommand };
};
