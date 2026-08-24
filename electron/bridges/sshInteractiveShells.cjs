"use strict";

const { executeBoundedSshCommand } = require("./boundedSshExec.cjs");
const { isSshChannelOpenRateLimitedError } = require("./boundedSshChannelOpen.cjs");

const SCAN_COMPLETE_MARKER = "__NETCATTY_SHELL_SCAN_COMPLETE__";
const discoveryDisabledConnections = new WeakSet();

function buildInteractiveShellPidCommand(quoteShellArg) {
  const script = `SELF=$$
ps_output=$(ps -e -o pid=,ppid=,tty=,comm=,etimes= 2>/dev/null) || ps_output=$(ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null) || exit 69
{
  printf '%s\n' "$ps_output" | awk -v pp="$PPID" -v self="$SELF" '
    function isshell(c) { sub(/^.*\\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
    $1 != self && $2 == pp && $3 !~ /^\\?+$/ && isshell($4) {
      if (NF >= 5 && $5 ~ /^[0-9]+$/) print $1, $5+0
      else print $1
    }
  '
  if [ -r /proc/$SELF/environ ]; then
    conn=$(tr '\\0' '\\n' < /proc/$SELF/environ 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
    if [ -n "$conn" ]; then
      for d in /proc/[0-9]*; do
        pid=$(basename "$d")
        [ "$pid" = "$SELF" ] && continue
        [ -r "$d/environ" ] || continue
        conn2=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
        [ "$conn2" = "$conn" ] || continue
        comm=$(cat "$d/comm" 2>/dev/null)
        case "$comm" in sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh) ;; *) continue ;; esac
        ppid=$(awk '{ print $4 }' "$d/stat" 2>/dev/null)
        pcomm=$(cat "/proc/$ppid/comm" 2>/dev/null)
        case "$pcomm" in sshd|dropbear|dropbearmulti) ;; *) continue ;; esac
        tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d '[:space:]')
        [ -n "$tty" ] && [ "$tty" != "?" ] || continue
        etimes=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d '[:space:]')
        case "$etimes" in
          ''|*[!0-9]*) printf '%s\\n' "$pid" ;;
          *) printf '%s %s\\n' "$pid" "$etimes" ;;
        esac
      done
    fi
  fi
} | awk '/^[0-9]+/ && !seen[$1]++ { print }'
printf '%s\n' '${SCAN_COMPLETE_MARKER}'`;
  return `exec sh -c ${quoteShellArg(script)}`;
}

async function listInteractiveShellPids(conn, options = {}) {
  if (!conn || typeof conn.exec !== "function" || typeof options.quoteShellArg !== "function") {
    return { available: false, pids: [], ages: {} };
  }
  const invalidateOnOpenTimeout = options.invalidateOnOpenTimeout === true;
  if (!invalidateOnOpenTimeout && discoveryDisabledConnections.has(conn)) {
    return { available: false, disabled: true, pids: [], ages: {} };
  }
  // Shell PID discovery only improves cwd recovery for reused shells. A slow
  // auxiliary exec open must not invalidate the physical transport and close
  // every interactive shell sharing it. After one open timeout, stop probing
  // this connection so ssh2 cannot retain another uncancellable callback on
  // every later reuse.
  try {
    const result = await executeBoundedSshCommand(
      conn,
      buildInteractiveShellPidCommand(options.quoteShellArg),
      {
        openingTimeoutMs: options.openingTimeoutMs ?? 1500,
        runTimeoutMs: options.runTimeoutMs ?? 1500,
        maxOutputBytes: 1024 * 1024,
        setTimeoutFn: options.setTimeoutFn,
        clearTimeoutFn: options.clearTimeoutFn,
        invalidateOnOpenTimeout,
      },
    );
    const lines = result.stdout.split(/\r?\n/);
    const available = lines.includes(SCAN_COMPLETE_MARKER)
      && (result.code === null || result.code === 0);
    const pids = [];
    const ages = {};
    if (available) {
      for (const line of lines) {
        const match = /^(\d+)(?:\s+(\d+))?$/.exec(String(line || "").trim());
        if (!match) continue;
        const pid = match[1];
        if (!pids.includes(pid)) pids.push(pid);
        if (match[2] !== undefined) ages[pid] = Number(match[2]);
      }
    }
    return { available, pids, ages };
  } catch (error) {
    const openTimedOut = error?.code === "SSH_EXEC_OPEN_TIMEOUT";
    if (openTimedOut && !invalidateOnOpenTimeout) {
      discoveryDisabledConnections.add(conn);
    }
    return {
      available: false,
      rateLimited: isSshChannelOpenRateLimitedError(error),
      openTimedOut,
      pids: [],
      ages: {},
    };
  }
}

module.exports = { buildInteractiveShellPidCommand, listInteractiveShellPids };
