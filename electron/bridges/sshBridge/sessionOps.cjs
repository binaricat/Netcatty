/* eslint-disable no-undef */
function decodeLsofFileName(value) {
  if (typeof value !== 'string') return null;
  // lsof's caret form is ambiguous: a BEL byte and the literal characters
  // "^G" have the same output. Reject it instead of navigating to a guessed path.
  if (/\^[\x40-\x5f?]/.test(value)) return null;
  const bytes = [];
  const simpleEscapes = {
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    '\\': 0x5c,
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const escaped = value[index + 1];
    if (!escaped) return null;
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      bytes.push(simpleEscapes[escaped]);
      index += 1;
      continue;
    }
    if (escaped === 'x') {
      const hex = value.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    return null;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function createSessionOpsApi(ctx) {
  with (ctx) {
    function getTcpLatencyTarget(session) {
      if (session.tcpLatencyDirect === false) return null;

      const auth = session.tcpLatencyTarget || session.moshStatsAuth || session.etStatsAuth || session._reuseEndpoint || null;
      if (auth?.hasJumpHost || auth?.hasProxy) return null;

      const hostname = auth?.hostname || session.hostname;
      const rawPort = auth?.port ?? 22;
      const port = Number(rawPort);
      if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return { hostname, port };
    }

    async function getSessionRemoteInfo(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      return {
        success: true,
        remoteSshVersion: session.remoteSshVersion || '',
      };
    }
    
    /**
     * Run the distro-identification probe on an already-connected SSH
     * session's connection. Uses an exec channel on the existing conn —
     * which is still one extra channel (and therefore one extra AAA
     * session on vendor CLIs that don't multiplex channels cleanly), but
     * avoids the full auth round-trip that `execCommand` would do by
     * creating a brand new SSHClient. The renderer only falls through to
     * this when banner classification returned no vendor, so in practice
     * it never runs against Cisco/Huawei/HPE/etc. — only against
     * Linux-like hosts and OpenSSH-fronted network devices (JUNOS,
     * NX-OS, EOS) that are already handled by the useServerStats
     * failure-counter path downstream.
     */
    async function getSessionDistroInfo(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (session?.type === "et") {
        if (typeof execOnEtSession !== "function") {
          return { success: false, error: "ET command executor unavailable" };
        }
        return execOnEtSession(session, "cat /etc/os-release 2>/dev/null || uname -a", 5000, {
          requireTrustedHost: true,
          knownHosts: session.etStatsAuth?.knownHosts,
        });
      }
      if (!session || !session.conn) {
        return { success: false, error: 'Session not found or not connected' };
      }
      const command = "cat /etc/os-release 2>/dev/null || uname -a";
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: 'Timeout probing distro' });
          // Clean up the exec channel so it doesn't linger.
          try { if (activeStream) activeStream.close(); } catch { /* ignore */ }
        }, 5000);
        let activeStream = null;
        try {
          session.conn.exec(command, (err, stream) => {
            if (err) {
              settle({ success: false, error: err.message || String(err) });
              return;
            }
            activeStream = stream;
            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk) => { stdout += chunk.toString(); });
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            stream.on('close', () => {
              settle({ success: true, stdout, stderr });
            });
          });
        } catch (err) {
          settle({ success: false, error: err?.message || String(err) });
        }
      });
    }

    async function readRemoteHistory(event, payload) {
      const { sessionId, limit } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      const safeLimit =
        Number.isFinite(limit) && limit > 0 && limit <= 10000 ? Math.floor(limit) : 1000;
      const fishLimit = safeLimit * 3; // fish records span 2-3 lines each

      const SHELL_MARKER = '__NC_SHELL__';
      const BASH_MARKER = '__NC_BASH__';
      const ZSH_MARKER = '__NC_ZSH__';
      const FISH_MARKER = '__NC_FISH__';
      // Shell parameter expansions kept as literal text so the remote POSIX
      // shell (not Node or the user's login shell) resolves them; honours
      // $HISTFILE / $XDG_DATA_HOME overrides.
      const ZSH_HIST = '${HISTFILE:-$HOME/.zsh_history}';
      const BASH_HIST = '${HISTFILE:-$HOME/.bash_history}';
      const FISH_PATH = '${XDG_DATA_HOME:-$HOME/.local/share}/fish/fish_history';
      const posixScript = [
        `SH="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; [ -n "$SH" ] || SH="$SHELL"`,
        `FISH="${FISH_PATH}"; [ -f "$FISH" ] || FISH="$HOME/.config/fish/fish_history"`,
        `case "$SH" in`,
        `  *zsh) printf '%s\\n' '${SHELL_MARKER}zsh'; printf '%s\\n' '${ZSH_MARKER}'; tail -n ${safeLimit} "${ZSH_HIST}" 2>/dev/null || true ;;`,
        `  *bash) printf '%s\\n' '${SHELL_MARKER}bash'; printf '%s\\n' '${BASH_MARKER}'; tail -n ${safeLimit} "${BASH_HIST}" 2>/dev/null || true ;;`,
        `  *fish) printf '%s\\n' '${SHELL_MARKER}fish'; printf '%s\\n' '${FISH_MARKER}'; tail -n ${fishLimit} "$FISH" 2>/dev/null || true ;;`,
        `  *) printf '%s\\n' '${SHELL_MARKER}unknown'; printf '%s\\n' '${BASH_MARKER}'; tail -n ${safeLimit} "$HOME/.bash_history" 2>/dev/null || true; printf '%s\\n' '${ZSH_MARKER}'; tail -n ${safeLimit} "$HOME/.zsh_history" 2>/dev/null || true; printf '%s\\n' '${FISH_MARKER}'; tail -n ${fishLimit} "$FISH" 2>/dev/null || true ;;`,
        `esac`,
      ].join('\n');
      // Match getSessionPwd: force POSIX sh so fish/zsh login shells do not
      // parse the script themselves.
      const command = `exec sh -c ${quoteShellArg(posixScript)}`;

      const parse = (stdout) => {
        const text = stdout || '';
        let shell = 'unknown';
        const shellIdx = text.indexOf(SHELL_MARKER);
        if (shellIdx >= 0) {
          const after = text.slice(shellIdx + SHELL_MARKER.length);
          shell = (after.split(/\r?\n/, 1)[0] || 'unknown').trim();
        }
        const section = (marker) => {
          const start = text.indexOf(marker);
          if (start < 0) return '';
          const from = start + marker.length;
          // End at the nearest following section marker, if any.
          const ends = [BASH_MARKER, ZSH_MARKER, FISH_MARKER]
            .map((m) => text.indexOf(m, from))
            .filter((i) => i >= 0);
          const end = ends.length ? Math.min(...ends) : text.length;
          return text.slice(from, end).replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
        };
        return {
          shell,
          bash: section(BASH_MARKER),
          zsh: section(ZSH_MARKER),
          fish: section(FISH_MARKER),
        };
      };

      // ET session: no ssh2 conn — run through the shared system-ssh executor.
      if (session.type === 'et') {
        if (typeof execOnEtSession !== 'function') {
          return { success: false, error: 'ET command executor unavailable' };
        }
        const result = await execOnEtSession(session, command, 8000);
        if (!result || !result.success) {
          return {
            success: false,
            error: (result && result.error) || 'Failed to read remote history',
          };
        }
        return { success: true, ...parse(result.stdout || '') };
      }

      // Mosh has no interactive ssh2 conn of its own. Lazily open the same
      // stats companion getServerStats uses — it lives on session.moshStatsConn,
      // never session.conn (see moshStatsConnection.cjs). Reading the fixed
      // history files is connection-agnostic, so the companion is a safe
      // substitute here (unlike getSessionPwd, which needs the interactive
      // shell's sibling exec channel).
      if (
        !session.conn &&
        !session.moshStatsConn &&
        session.type === 'mosh' &&
        typeof ensureMoshStatsConnection === 'function'
      ) {
        await ensureMoshStatsConnection(session, sessionId, event?.sender);
      }

      const conn = session.conn || session.moshStatsConn;
      if (!conn) {
        // A Mosh session can be marked "connected" before the handshake stores
        // credentials; report pending (mirrors getServerStats) so it isn't a
        // hard failure during that window.
        if (session.type === 'mosh' && !session.moshStatsAuth && !session.moshStatsConnFailed) {
          return { success: false, pending: true, error: 'Mosh handshake in progress' };
        }
        return { success: false, error: 'Session not found or not connected' };
      }

      return new Promise((resolve) => {
        let settled = false;
        let activeStream = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: 'Timeout reading remote history' });
          try { if (activeStream) activeStream.close(); } catch { /* ignore */ }
        }, 8000);
        try {
          conn.exec(command, (err, stream) => {
            if (err) {
              settle({ success: false, error: err.message || String(err) });
              return;
            }
            activeStream = stream;
            let stdout = '';
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            if (stream.stderr) stream.stderr.on('data', () => { /* swallow */ });
            stream.on('close', () => {
              settle({ success: true, ...parse(stdout) });
            });
          });
        } catch (err) {
          settle({ success: false, error: err?.message || String(err) });
        }
      });
    }
    
    async function getSessionPwd(event, payload) {
      const { sessionId } = payload;
      const allowHomeFallback = payload?.allowHomeFallback !== false;
      const session = sessions.get(sessionId);
    
      if (!session || !session.conn) {
        return { success: false, error: 'Session not found or not connected' };
      }

      const targetLoginPid = /^\d+$/.test(String(session.shellPid || ''))
        ? String(session.shellPid)
        : '';
      const sharedTerminalCount = session.connRef
        ? [...sessions.values()].filter(
          (candidate) => candidate?.connRef === session.connRef && candidate?.stream,
        ).length
        : 1;
      if (sharedTerminalCount > 1 && !targetLoginPid) {
        return {
          success: false,
          error: 'Current directory is ambiguous across shared terminal channels',
        };
      }
    
      // Completely silent: uses a separate exec channel, nothing is printed
      // in the interactive terminal. The exec channel and the interactive
      // shell are both children of the same per-connection sshd process,
      // so we find the shell as a sibling via $PPID.
      return new Promise((resolve) => {
        let settled = false;
        let activeStream = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: 'Timeout getting pwd' });
          try { activeStream?.close(); } catch { /* ignore */ }
        }, 5000);
    
        // POSIX sh script that:
        //   1. Finds the user's interactive shell on the same SSH connection
        //      (sibling under $PPID on newer OpenSSH, cousin reachable via the
        //      shared SSH_CONNECTION env var on older OpenSSH like CentOS 7).
        //   2. Follows foreground child shells only, which covers bash->fish
        //      without mistaking background shell scripts for the active shell.
        //   3. Reads /proc/<pid>/cwd via readlink.
        //   4. Falls back to the user's home directory if the caller allows it.
        //
        // `exec` makes sh replace the user's login shell (fish/bash/...)
        // so sh keeps the same PID and $PPID = sshd. Starting another shell
        // without exec would make $PPID point at the intermediate shell instead.
        const posixScript = `SELF=$$
    TARGET_LOGIN=${targetLoginPid}
    ALLOW_FALLBACK=${allowHomeFallback ? "1" : "0"}
    # Find the user's interactive shell on this SSH connection.
    # Prefer the one attached to a controlling tty (the user's shell): probe exec
    # channels like this one have no tty ("?"), and ps output is unsorted, so
    # without the tty preference a concurrent probe's shell could be picked when
    # several exist under the same sshd (#1065 review). Falls back to any shell
    # child if none has a tty.
    #
    # Strategy: try direct siblings of $PPID first — works on newer OpenSSH where
    # the PTY session and this exec channel share the same per-connection sshd
    # parent. Fall back to matching by SSH_CONNECTION env var, which covers older
    # OpenSSH (e.g. CentOS 7 / RHEL 7) that forks a SEPARATE sshd child per
    # channel — there the PTY shell ends up as a cousin (same grandparent sshd,
    # different parent) of this exec session, so the sibling search misses it
    # entirely (#1123).
    find_login_shell() {
      _shell=$(ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null | awk -v pp="$1" -v self="$SELF" '
        function isshell(c) { sub(/^.*\\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
        $1 != self && $2 == pp && isshell($4) {
          if ($3 !~ /^\\?+$/) { print $1; found=1; exit }
          if (any == "") any=$1
        }
        END { if (!found && any != "") print any }
      ')
      [ -n "$_shell" ] && { echo "$_shell"; return; }
      # SSH_CONNECTION is the unique client-port/server-port 4-tuple sshd injects
      # into every channel of one SSH connection, so processes that share it are
      # the channels of this very connection — and exactly one of them is the
      # user's PTY shell. Read /proc/<pid>/environ (NUL-separated, same uid only)
      # to find candidates, then pick the one with a shell comm and a controlling
      # tty. /proc/<pid>/comm is read directly here because ps -p PID -o tty=,comm=
      # gets misparsed on older procps (CentOS 7): the trailing ",comm=" is folded
      # into the tty column header instead of starting a second column, so tty and
      # comm come back swapped.
      _conn=$(tr '\\0' '\\n' < /proc/$SELF/environ 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
      [ -z "$_conn" ] && return
      _any=""
      for _d in /proc/[0-9]*; do
        _pid=$(basename "$_d")
        [ "$_pid" = "$SELF" ] && continue
        [ -r "$_d/environ" ] || continue
        _conn2=$(tr '\\0' '\\n' < "$_d/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -n1)
        [ "$_conn2" = "$_conn" ] || continue
        _comm=$(cat "$_d/comm" 2>/dev/null)
        case "$_comm" in
          sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh) ;;
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
    # From the login shell, pick the DEEPEST foreground shell in its process
    # subtree. "Foreground" = the controlling tty's foreground process group ("+"
    # in stat), i.e. the shell the user is actually typing in. Walking the whole
    # subtree (rather than only direct shell children) lets us follow through
    # non-shell foreground parents like su / sudo, so we read the cwd of the
    # su'd / sudo'd shell instead of stopping at the login shell (#1065). Falls
    # back to the login shell when no foreground shell is found.
    find_active_shell() {
      ps -e -o pid=,ppid=,stat=,comm= 2>/dev/null | awk -v start="$1" '
        { pp[$1]=$2; st[$1]=$3; cm[$1]=$4; ord[NR]=$1 }
        function isshell(c) { sub(/^.*\\//, "", c); sub(/^-/, "", c); return c ~ /^(ba|z|fi|k|da|a|c|tc)?sh$/ }
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
    # Read a process's cwd. Linux exposes it via /proc; systems without a
    # readable /proc fall back to lsof so the SFTP follow-terminal probe also
    # works on macOS and on BSD hosts that provide lsof (#2335). Both paths
    # only see same-uid processes, so a su'd / sudo'd shell owned by another
    # user stays unreadable here (handled by the login-shell fallback below).
    read_shell_cwd() {
      _rc_cwd=$(readlink "/proc/$1/cwd" 2>/dev/null)
      if [ -n "$_rc_cwd" ]; then printf '%s\\n' "$_rc_cwd"; return 0; fi
      if command -v lsof >/dev/null 2>&1; then
        _rc_cwd=$(LC_ALL=C lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)
        if [ -n "$_rc_cwd" ]; then printf 'NETCATTY_LSOF_CWD=%s\\n' "$_rc_cwd"; return 0; fi
      fi
      return 1
    }
    login="$TARGET_LOGIN"
    [ -n "$login" ] || login=$(find_login_shell "$PPID")
    if [ -n "$login" ]; then
      printf 'NETCATTY_LOGIN_PID=%s\\n' "$login" >&2
      pid=$(find_active_shell "$login")
      [ -n "$pid" ] || pid="$login"
      cwd=$(read_shell_cwd "$pid")
      # The active shell's cwd is only readable for same-uid processes (ptrace
      # perms on /proc, lsof permissions on macOS/BSD), so this unprivileged
      # exec channel cannot read a su'd / sudo'd shell owned by another user.
      # Fall back to the same-uid login shell's cwd before giving up to the
      # home directory (#1065 review).
      if [ -z "$cwd" ] && [ "$pid" != "$login" ] && [ "$ALLOW_FALLBACK" = "1" ]; then
        cwd=$(read_shell_cwd "$login")
      fi
      [ -n "$cwd" ] && printf '%s\\n' "$cwd" && exit 0
    fi
    [ "$ALLOW_FALLBACK" = "1" ] || exit 1
    emit_home() {
      case "$1" in
        /*) printf '%s\\n' "$1"; exit 0 ;;
      esac
    }
    home=$(eval echo "~" 2>/dev/null)
    emit_home "$home"
    uid=$(id -u 2>/dev/null)
    if [ -n "$uid" ]; then
      home=$(getent passwd "$uid" 2>/dev/null | awk -F: 'NR == 1 { print $6; exit }')
      emit_home "$home"
      home=$(awk -F: -v uid="$uid" '$3 == uid { print $6; exit }' /etc/passwd 2>/dev/null)
      emit_home "$home"
    fi
    home=$(id -P 2>/dev/null | awk -F: 'NR == 1 { print $9; exit }')
    emit_home "$home"
    emit_home "$HOME"
    exit 1`;
        const cmd = `exec sh -c ${quoteShellArg(posixScript)}`;
    
        try {
          session.conn.exec(cmd, (err, stream) => {
            if (settled) {
              try { stream?.close(); } catch { /* ignore */ }
              return;
            }
            if (err) {
              log('[getSessionPwd] exec error:', err.message);
              settle({ success: false, error: err.message });
              return;
            }
            activeStream = stream;
            let out = '';
            let errOut = '';
            stream.on('data', (d) => { out += d.toString(); });
            stream.stderr?.on('data', (d) => { errOut += d.toString(); });
            stream.on('close', (code) => {
              if (settled) return;
              const rawPath = out.replace(/\r?\n$/, '');
              const lsofPrefix = 'NETCATTY_LSOF_CWD=';
              const path = rawPath.startsWith(lsofPrefix)
                ? decodeLsofFileName(rawPath.slice(lsofPrefix.length))
                : rawPath;
              const loginPidMatch = errOut.match(/(?:^|\n)NETCATTY_LOGIN_PID=(\d+)(?:\n|$)/);
              if (loginPidMatch) {
                session.shellPid = loginPidMatch[1];
              }
              log('[getSessionPwd]', { stdout: rawPath, stderr: errOut.trim(), exitCode: code });
              if (path && path.startsWith('/')) {
                settle({ success: true, cwd: path });
              } else {
                settle({ success: false, error: 'Could not determine cwd' });
              }
            });
          });
        } catch (err) {
          settle({ success: false, error: err?.message || String(err) });
        }
      });
    }
    
    // Resolve the directory the running `rz` writes to (its own cwd) and report
    // which of `names` already exist there. Returns { dir, existing } or null.
    function probeReceiveConflicts(session, names) {
      return new Promise((resolve) => {
        if (!session || !session.conn || !Array.isArray(names) || names.length === 0) {
          return resolve(null);
        }
        const timer = setTimeout(() => resolve(null), 5000);
        const script = `SELF=$$
    find_login_shell() {
      ps -e -o pid=,ppid=,tty=,comm= 2>/dev/null | awk -v pp="$1" -v self="$SELF" '
        $1 != self && $2 == pp && $4 ~ /^-?(ba|z|fi|k|da|a)?sh$/ {
          if ($3 != "?") { print $1; found=1; exit }
          if (any == "") any=$1
        }
        END { if (!found && any != "") print any }'
    }
    find_fg_leaf() {
      ps -e -o pid=,ppid=,stat=,comm= 2>/dev/null | awk -v start="$1" '
        { pp[$1]=$2; st[$1]=$3; ord[NR]=$1 }
        function depth(p,  d){ d=0; while(p!="" && d<64){ if(p==start) return d; p=pp[p]; d++ } return -1 }
        END { best=-1; bp=""; for(i=1;i<=NR;i++){ p=ord[i];
          if(index(st[p],"+")==0) continue; d=depth(p); if(d<0) continue;
          if(d>best){best=d; bp=p} } print bp }'
    }
    login=$(find_login_shell "$PPID")
    [ -n "$login" ] || exit 0
    leaf=$(find_fg_leaf "$login")
    [ -n "$leaf" ] || leaf="$login"
    dir=$(readlink /proc/$leaf/cwd 2>/dev/null)
    [ -n "$dir" ] || exit 0
    printf 'DIR\\t%s\\n' "$dir"
    cd "$dir" 2>/dev/null || exit 0
    for n in "$@"; do
      [ -e "$n" ] || continue
      m=$(stat -c %a -- "$n" 2>/dev/null || stat -f %Lp -- "$n" 2>/dev/null)
      printf 'EXIST\\t%s\\t%s\\n' "$n" "$m"
    done`;
        const argv = names.map((n) => quoteShellArg(n)).join(" ");
        const cmd = `exec sh -c ${quoteShellArg(script)} sh ${argv}`;
        session.conn.exec(cmd, (err, stream) => {
          if (err) { clearTimeout(timer); return resolve(null); }
          let out = "";
          stream.on("data", (d) => { out += d.toString(); });
          stream.on("close", () => {
            clearTimeout(timer);
            let dir = null; const existing = []; const modes = {};
            for (const line of out.split("\n")) {
              const [tag, val, mode] = line.split("\t");
              if (tag === "DIR") dir = val;
              else if (tag === "EXIST" && val) {
                existing.push(val);
                if (mode && /^[0-7]{3,4}$/.test(mode)) modes[val] = mode;
              }
            }
            resolve(dir ? { dir, existing, modes } : null);
          });
        });
      });
    }
    
    // rm -f the given absolute remote paths (quoted; injection-safe).
    function removeRemoteFiles(session, paths) {
      return new Promise((resolve) => {
        if (!session || !session.conn || !Array.isArray(paths) || paths.length === 0) return resolve();
        const argv = paths.map((p) => quoteShellArg(p)).join(" ");
        const timer = setTimeout(resolve, 5000);
        session.conn.exec(`exec sh -c 'rm -f -- "$@"' sh ${argv}`, (err, stream) => {
          if (err) { clearTimeout(timer); return resolve(); }
          stream.on("data", () => {}); stream.stderr?.on("data", () => {});
          stream.on("close", () => { clearTimeout(timer); resolve(); });
        });
      });
    }
    
    // chmod the given { path, mode } entries back to their captured permissions
    // (parameterized; injection-safe). Modes are validated octal before use.
    function restoreRemoteModes(session, entries) {
      return new Promise((resolve) => {
        if (!session || !session.conn || !Array.isArray(entries) || entries.length === 0) return resolve();
        const args = [];
        for (const e of entries) {
          if (!e || !e.path || !/^[0-7]{3,4}$/.test(String(e.mode))) continue;
          args.push(quoteShellArg(String(e.mode)));
          args.push(quoteShellArg(e.path));
        }
        if (args.length === 0) return resolve();
        const timer = setTimeout(resolve, 5000);
        const script = 'while [ "$#" -ge 2 ]; do chmod "$1" "$2" 2>/dev/null; shift 2; done';
        session.conn.exec(`exec sh -c ${quoteShellArg(script)} sh ${args.join(" ")}`, (err, stream) => {
          if (err) { clearTimeout(timer); return resolve(); }
          stream.on("data", () => {}); stream.stderr?.on("data", () => {});
          stream.on("close", () => { clearTimeout(timer); resolve(); });
        });
      });
    }
    
    /**
     * List directory contents on remote machine for path autocomplete.
     * Uses a separate exec channel — does not touch the interactive shell.
     */
    async function listSessionDir(_event, payload) {
      const {
        sessionId,
        path: dirPath,
        foldersOnly,
        filterPrefix = "",
        limit = 100,
      } = payload || {};
      const session = sessions.get(sessionId);
    
      if (!session || !session.conn) {
        return { success: false, entries: [], error: 'Session not found' };
      }
    
      if (typeof dirPath !== "string" || dirPath.length === 0) {
        return { success: false, entries: [], error: 'Invalid directory path' };
      }
    
      return new Promise((resolve) => {
        let settled = false;
        let streamRef = null;
        const resolveOnce = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          try {
            streamRef?.close?.();
            streamRef?.destroy?.();
          } catch {}
          resolveOnce({ success: false, entries: [], error: 'Timeout listing directory' });
        }, 3000);
    
        // Emit a NUL-delimited stream from plain POSIX shell/find so we don't depend on
        // Python/Perl, while still preserving whitespace and newline characters in filenames.
        const safePath = dirPath.replace(/'/g, "'\\''");
        const tildePathSuffix = dirPath.startsWith("~/")
          ? dirPath.slice(2).replace(/(["\\$`])/g, "\\$1")
          : "";
        const normalizedPrefix = typeof filterPrefix === "string" ? filterPrefix.toLowerCase() : "";
        const safePrefix = normalizedPrefix.replace(/'/g, "'\\''");
        const maxEntries = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 100;
        const pathExpr = dirPath === "~"
          ? '"$HOME"'
          : dirPath.startsWith("~/")
            ? `"$HOME/${tildePathSuffix}"`
            : `'${safePath}'`;
        // When dirPath is relative (not absolute and not ~/...), exec channels default
        // to the user's home directory. Resolve the interactive shell's actual cwd first
        // so that relative paths like "." or "src" are resolved correctly.
        const needsCwdResolve = !dirPath.startsWith('/') && dirPath !== '~' && !dirPath.startsWith('~/');
        const cwdResolveCmd = needsCwdResolve
          ? `_sc_p=$(ps --ppid $PPID -o pid=,comm= 2>/dev/null | awk -v self=$$ '$1!=self && $2~/^(ba|z|fi|k|da)?sh$/{pid=$1}END{print pid}'); [ -z "$_sc_p" ] && _sc_p=$(ps -e -o pid=,ppid=,comm= 2>/dev/null | awk -v pp=$PPID -v self=$$ '$1!=self && $2==pp && $3~/^(ba|z|fi|k|da)?sh$/{pid=$1}END{print pid}'); [ -n "$_sc_p" ] && { _sc_d=$(readlink /proc/$_sc_p/cwd 2>/dev/null); [ -n "$_sc_d" ] && cd "$_sc_d" 2>/dev/null; }; `
          : '';
        const cmd = `${cwdResolveCmd}find ${pathExpr} -mindepth 1 -maxdepth 1 -exec sh -c '
          prefix="$1"
          folders_only="$2"
          limit="$3"
          shift 3
          count=0
          for path do
            name=\${path##*/}
            lower_name=$(printf "%s" "$name" | tr "[:upper:]" "[:lower:]")
            if [ -n "$prefix" ]; then
              case "$lower_name" in
                "$prefix"*) ;;
                *) continue ;;
              esac
            fi
            if [ "$folders_only" -eq 1 ] && [ ! -d "$path" ]; then
              continue
            fi
            if [ -L "$path" ]; then
              type="symlink"
            elif [ -d "$path" ]; then
              type="directory"
            else
              type="file"
            fi
            printf "%s\\0%s\\0" "$name" "$type"
            count=$((count + 1))
            if [ "$count" -ge "$limit" ]; then
              break
            fi
          done
        ' sh '${safePrefix}' ${foldersOnly ? 1 : 0} ${maxEntries} {} + 2>/dev/null`;
    
        session.conn.exec(cmd, (err, stream) => {
          if (err) {
            resolveOnce({ success: false, entries: [], error: err.message });
            return;
          }
          streamRef = stream;
          const chunks = [];
          let errOut = '';
          stream.on('data', (d) => { chunks.push(Buffer.from(d)); });
          stream.stderr?.on('data', (d) => { errOut += d.toString(); });
          stream.on('close', () => {
            if (settled) return;
            try {
              const output = Buffer.concat(chunks);
              const entries = [];
              let fieldStart = 0;
              let pendingName = null;
    
              for (let i = 0; i < output.length; i++) {
                if (output[i] !== 0) continue;
                const field = output.toString('utf8', fieldStart, i);
                fieldStart = i + 1;
                if (pendingName === null) {
                  pendingName = field;
                } else {
                  entries.push({ name: pendingName, type: field });
                  pendingName = null;
                  if (entries.length >= maxEntries) break;
                }
              }
    
              if (pendingName !== null) {
                resolveOnce({ success: false, entries: [], error: 'Invalid directory listing response' });
                return;
              }
    
              resolveOnce({ success: true, entries });
            } catch {
              resolveOnce({
                success: false,
                entries: [],
                error: errOut.trim() || 'Failed to parse directory listing',
              });
            }
          });
        });
      });
    }
    
    /**
     * Get server stats (CPU, Memory, Disk) from an active SSH session
     * Only works for Linux servers
     */
    async function getServerStats(event, payload) {
      const { sessionId } = payload;
      const session = sessions.get(sessionId);

      if (!session) {
        return { success: false, error: 'Session not found or not connected' };
      }

      const isEtSession = session.type === "et";
      const etUsesExecFallback = isEtSession && session.etStatsAuth?.hasJumpHost;

      function createBufferedExecStream(stdout = "", stderr = "") {
        const stream = {
          stderr: {
            on(eventName, handler) {
              if (eventName === "data" && stderr) {
                setTimeout(() => handler(Buffer.from(stderr)), 0);
              }
              return this;
            },
          },
          on(eventName, handler) {
            if (eventName === "data" && stdout) {
              setTimeout(() => handler(Buffer.from(stdout)), 0);
            }
            if (eventName === "close") {
              setTimeout(() => handler(0), 0);
            }
            return this;
          },
          close() {},
          destroy() {},
        };
        return stream;
      }

      function createEtStatsExecConn(etSession) {
        return {
          exec(command, cb) {
            execOnEtSession(etSession, command, 10000, {
              requireTrustedHost: true,
              knownHosts: etSession.etStatsAuth?.knownHosts,
            })
              .then((result) => {
                if (!result?.success) {
                  cb(new Error(result?.error || result?.stderr || "ET stats command failed"));
                  return;
                }
                cb(null, createBufferedExecStream(result.stdout || "", result.stderr || ""));
              })
              .catch((err) => {
                cb(err instanceof Error ? err : new Error(String(err)));
              });
          },
        };
      }

      // Mosh and direct ET sessions run through external PTYs and have no
      // ssh2 connection of their own. Lazily open a best-effort companion SSH
      // connection (reusing credentials) so the host-info bar can use the same
      // stats parser as normal SSH. The companion lives on protocol-specific
      // fields — never session.conn — so other bridges do not mistake it for
      // the interactive connection. ET sessions with a jump host use the
      // already-prepared OpenSSH environment via execOnEtSession instead.
      if (!session.conn && !session.moshStatsConn && !session.etStatsConn) {
        if (session.type === 'mosh' && typeof ensureMoshStatsConnection === 'function') {
          await ensureMoshStatsConnection(session, sessionId, event?.sender);
        } else if (
          isEtSession &&
          !etUsesExecFallback &&
          !session.etStatsConnFailed &&
          typeof ensureEtStatsConnection === 'function'
        ) {
          await ensureEtStatsConnection(session, sessionId, event?.sender);
        }
      }

      const canExecEtStats =
        isEtSession &&
        typeof execOnEtSession === "function" &&
        !!session.sshUserHost &&
        !session.externalAuthArtifactsCleaned;
      const sshStatsConn = session.conn || session.moshStatsConn || session.etStatsConn;
      const usesEtStatsFallback = !sshStatsConn && canExecEtStats;
      const conn = sshStatsConn || (usesEtStatsFallback ? createEtStatsExecConn(session) : null);
      if (!conn) {
        // A Mosh session can be marked "connected" (and start polling) from
        // the SSH bootstrap's visible output before swapToMoshClient stores
        // moshStatsAuth. During that window there is nothing to connect with
        // yet — report it as `pending` (not a hard failure) so the renderer's
        // give-up-after-N-failures counter doesn't permanently disable stats
        // before the handshake finishes and credentials become available.
        if (session.type === 'mosh' && !session.moshStatsAuth && !session.moshStatsConnFailed) {
          return { success: false, pending: true, error: 'Mosh handshake in progress' };
        }
        return { success: false, error: 'Session not found or not connected' };
      }
    
      // macOS stats command: uses sysctl, vm_stat, ps, df, netstat
      // CPU is a fast best-effort sum of process %CPU normalized by logical cores.
      // cpuPerCore not available on macOS without sudo
      const macosStatsCommand = [
        `cores=$(sysctl -n hw.logicalcpu 2>/dev/null || echo "1")`,
        `pagesize=$(sysctl -n hw.pagesize 2>/dev/null || echo "4096")`,
        `memsize=$(sysctl -n hw.memsize 2>/dev/null || echo "0")`,
        // CPU usage: avoid top here; on some remote macOS shells top can block long enough
        // to trip the stats timeout. ps is fast and present on supported macOS versions.
        `cpupct=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$cores" '{s+=$1} END{if(c<=0)c=1;s=s/c;if(s<0)s=0;if(s>100)s=100;printf "%.0f",s}')`,
        // Memory: single vm_stat pipe → awk extracts all page counts (strip trailing dots with gsub)
        // Outputs: "memfree memcached" in MB
        `vmmem=$(vm_stat 2>/dev/null | awk -v ps="$pagesize" '/^Pages free:/{gsub(/[^0-9]/,"",$NF);free=$NF+0} /^Pages speculative:/{gsub(/[^0-9]/,"",$NF);spec=$NF+0} /^Pages inactive:/{gsub(/[^0-9]/,"",$NF);inact=$NF+0} /^Pages purgeable:/{gsub(/[^0-9]/,"",$NF);purg=$NF+0} END{mfree=int((free+spec)*ps/1024/1024);mcached=int((inact+purg)*ps/1024/1024);printf "%d %d",mfree,mcached}')`,
        `memtotal=$(echo "$memsize" | awk '{printf "%d",$1/1024/1024}')`,
        `memfree=$(echo "$vmmem" | awk '{print $1}')`,
        `memcached=$(echo "$vmmem" | awk '{print $2}')`,
        // Swap
        `swapraw=$(sysctl vm.swapusage 2>/dev/null)`,
        `swaptotal=$(echo "$swapraw" | awk '{for(i=1;i<=NF;i++){if($i=="total"&&$(i+1)=="="){v=$(i+2);m=1;if(v~/G/)m=1024;gsub(/[MmGg]/,"",v);st=v*m}};printf "%.0f",st+0}')`,
        `swapused=$(echo "$swapraw" | awk '{for(i=1;i<=NF;i++){if($i=="used"&&$(i+1)=="="){v=$(i+2);m=1;if(v~/G/)m=1024;gsub(/[MmGg]/,"",v);su=v*m}};printf "%.0f",su+0}')`,
        `swapfree=$(echo "$swaptotal $swapused" | awk '{printf "%.0f",$1-$2}')`,
        // Top processes by memory%
        `procs=$(ps -A -o pid=,%mem=,comm= 2>/dev/null | sort -k2 -rn | head -10 | awk '{gsub(/;/,"_",$3);printf "%s;%.1f;%s,",$1,$2,$3}' | sed 's/,$//')`,
        // Disk: -P keeps a stable six-column POSIX layout on macOS.
        `mounts=$(mount 2>/dev/null || true)`,
        `disks=$({ printf "%s\n" "$mounts"; printf "__NETCATTY_DF__\n"; df -kP 2>/dev/null; } | awk '$0=="__NETCATTY_DF__"{in_df=1;next} !in_df{if($1~/^\/dev\/disk/&&(index($0,"(apfs,")||index($0,"(apfs)"))){key=$1;sub(/s[0-9].*$/,"",key);capacity[$1]="apfs:" key}next} $1=="Filesystem"{next} index($1,"/dev/")==1{m=$6;if(m=="/"||index(m,"/Volumes/")==1){t=$2/1048576;key=(($1 in capacity)?capacity[$1]:$1);if(key~/^apfs:/){u=($2-$4)/1048576;p=(t>0?int(u*100/t+0.5):0)}else{u=$3/1048576;p=$5;gsub(/%/,"",p)}printf "%s:%.6f:%.6f:%s:%s,",m,u,t,p,key}}' | sed 's/,$//')`,
        // Network: Link# lines only, exclude loopback, detect column shift (no MAC addr → cols shift left)
        `net=$(netstat -ibn 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++){if($i=="Ibytes")ib=i;if($i=="Obytes")ob=i}next} ib&&ob&&$1~/^[[:alpha:]]/&&$1!~/^lo/&&$0~/<Link#/{name=$1;gsub(/[*]/,"",name);rx=$(ib)+0;tx=$(ob)+0;if(rx>0||tx>0){seen[name]=rx ":" tx}} END{for(name in seen)printf "%s:%s,",name,seen[name]}' | sed 's/,$//')`,
        `hostname_value=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo "")`,
        `osname=$(printf "%s %s" "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" | sed 's/[[:space:]]*$//')`,
        `kernel=$(uname -r 2>/dev/null || echo "")`,
        `bootsec=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,]+' '{for(i=1;i<=NF;i++){if($i=="sec"){print $(i+2);exit}}}')`,
        `nowsec=$(date +%s 2>/dev/null || echo "0")`,
        `uptime=$(awk -v n="$nowsec" -v b="$bootsec" 'BEGIN{if(n>0&&b>0)printf "%.0f",n-b}')`,
        `loadavg=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1" "$2" "$3"}')`,
        `echo "CPU:$cpupct|CORES:$cores|MEMINFO:$memtotal $memfree 0 $memcached $swaptotal $swapfree|PROCS:$procs|DISKS:$disks|NET:$net|HOST:$hostname_value|OS:$osname|KERNEL:$kernel|UPTIME:$uptime|LOAD:$loadavg"`,
      ].join('; ');
    
      // Command to get CPU (overall + per-core), Memory, Disk, and Network stats
      // This command is designed to work across most Linux distributions
      // Note: Using semicolons and avoiding comments for single-line execution
      // CPU: Output raw values (total and idle) instead of percentage - we calculate delta on backend
      const linuxStatsCommand = [
        // Get number of CPU cores
        `cores=$(nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo 2>/dev/null || echo "1")`,
        // Get raw CPU values from /proc/stat: "total idle" for overall CPU
        // We output raw values and calculate delta-based percentage on the backend
        `cpuraw=$(awk '/^cpu / {total=0; for(i=2;i<=NF;i++) total+=$i; printf "%d %d", total, $5}' /proc/stat 2>/dev/null || echo "")`,
        // Get raw per-core CPU values from /proc/stat: "total:idle,total:idle,..."
        `percoreraw=$(awk '/^cpu[0-9]/ {total=0; for(i=2;i<=NF;i++) total+=$i; printf "%d:%d,", total, $5}' /proc/stat 2>/dev/null | sed 's/,$//' || echo "")`,
        // Get memory details from /proc/meminfo (total, free, buffers, cached, swapTotal, swapFree in KB)
        `meminfo=$(awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} /^SReclaimable:/{s=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{printf "%d %d %d %d %d %d", t/1024, f/1024, b/1024, (c+s)/1024, st/1024, sf/1024}' /proc/meminfo 2>/dev/null || echo "")`,
        // Get top 10 processes by memory - with BusyBox fallback
        // GNU ps: ps -eo pid,%mem,comm --sort=-%mem
        // BusyBox fallback: top exposes %VSZ/%CPU; minimal builds without top use plain ps VSZ.
        `procs=$(if procraw=$(ps -eo pid,%mem,comm --sort=-%mem 2>/dev/null); then printf "%s\n" "$procraw" | awk 'NR>1 && NR<=11 {gsub(/;/, "_", $3); printf "%s;%.1f;%s,", $1, $2, $3}' | sed 's/,$//'; elif topraw=$(top -b -n 1 2>/dev/null); then printf "%s\n" "$topraw" | awk '$1 == "PID" {for(i=1;i<=NF;i++){if($i=="%VSZ") mem_col=i; else if($i=="COMMAND") cmd_col=i} next} $1 ~ /^[0-9]+$/ && mem_col && cmd_col {pct=$(mem_col); gsub(/%/, "", pct); cmd=$(cmd_col); gsub(/;/, "_", cmd); print pct ";" $1 ";" cmd}' | sort -t ';' -k1,1rn | head -10 | awk -F';' '{printf "%s;%.1f;%s,", $2, $1, $3}' | sed 's/,$//'; else ps ww 2>/dev/null | awk -v total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo) '$1 ~ /^[0-9]+$/ {v=$3; unit=substr(v,length(v),1); mult=1; if(unit=="m"||unit=="M")mult=1024; else if(unit=="g"||unit=="G")mult=1048576; sub(/[mMgG]$/, "", v); pct=total>0?v*mult*100/total:0; cmd=$5; gsub(/;/, "_", cmd); print pct, $1, cmd}' | sort -rn | head -10 | awk '{printf "%s;%.1f;%s,", $2, $1, $3}' | sed 's/,$//'; fi)`,
        // Get all mounted disk info. POSIX -kP is supported by GNU and BusyBox
        // and preserves enough precision to aggregate several filesystems.
        `disks=$(df -kP 2>/dev/null | awk 'NR>1 && $1 !~ /^\\/dev\\/loop/ && ($6 == "/" || ($1 ~ /^\\/dev/ && $6 !~ /^\\/(etc|proc|sys|dev)(\\/|$)/)) {total=$2/1048576; used=$3/1048576; pct=$5; gsub(/%/,"",pct); printf "%s:%.6f:%.6f:%s:%s,", $6, used, total, pct, $1}' | sed 's/,$//')`,
        // Get network interface stats from /proc/net/dev (interface:rx_bytes:tx_bytes), excluding lo and virtual interfaces
        `net=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 {gsub(/^[ \\t]+/, ""); split($0, a, ":"); iface=a[1]; if(iface != "lo" && iface !~ /^veth/ && iface !~ /^docker/ && iface !~ /^br-/) {split(a[2], b); printf "%s:%s:%s,", iface, b[1], b[9]}}' | sed 's/,$//' || echo "")`,
        `hostname_value=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo "")`,
        `osname=$(awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2);print $2;exit}' /etc/os-release 2>/dev/null || uname -s 2>/dev/null || echo "")`,
        `kernel=$(uname -r 2>/dev/null || echo "")`,
        `uptime=$(awk '{printf "%.0f",$1}' /proc/uptime 2>/dev/null || echo "")`,
        `loadavg=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || echo "")`,
        // Output all stats (using CPURAW and PERCORERAW instead of CPU and PERCORE)
        `echo "CPURAW:$cpuraw|CORES:$cores|PERCORERAW:$percoreraw|MEMINFO:$meminfo|PROCS:$procs|DISKS:$disks|NET:$net|HOST:$hostname_value|OS:$osname|KERNEL:$kernel|UPTIME:$uptime|LOAD:$loadavg"`
      ].join('; ');
    
      // Auto-detect OS via uname — only Linux and macOS are supported
      const latencyMarker = "NC_LATENCY_MARK";
      const statsCommand = `printf "${latencyMarker}|"; ostype=$(uname -s 2>/dev/null || echo "Unknown"); if [ "$ostype" = "Darwin" ]; then ${macosStatsCommand}; elif [ "$ostype" = "Linux" ]; then ${linuxStatsCommand}; else echo "UNSUPPORTED_OS:$ostype"; fi`;
      const tcpLatencyTarget = getTcpLatencyTarget(session);
      const tcpLatencyPromise = tcpLatencyTarget && typeof measureTcpConnectLatency === 'function'
        ? Promise.resolve(measureTcpConnectLatency(tcpLatencyTarget)).catch(() => null)
        : Promise.resolve(null);
      return new Promise((resolve) => {
        let activeStream = null;
        let settled = false;
        let timeout = null;
        const disposeStream = (stream) => {
          if (!stream) return;
          try {
            if (typeof stream.close === 'function') stream.close();
            else if (typeof stream.destroy === 'function') stream.destroy();
          } catch {
            try { stream.destroy?.(); } catch { /* ignore cleanup errors */ }
          }
        };
        const settle = (result) => {
          if (settled) return false;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(result);
          return true;
        };
        timeout = setTimeout(() => {
          const stream = activeStream;
          activeStream = null;
          if (settle({ success: false, error: 'Timeout getting server stats' })) {
            disposeStream(stream);
          }
        }, 10000);
    
        conn.exec(statsCommand, (err, stream) => {
          if (settled) {
            disposeStream(stream);
            return;
          }
          if (err) {
            settle({ success: false, error: err.message });
            return;
          }
          activeStream = stream;
    
          let stdout = '';
          let stderr = '';
    
          stream.on('data', (data) => {
            stdout += data.toString();
          });
    
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
    
          stream.on('close', async () => {
            if (settled) return;
            activeStream = null;
            const measuredLatency = await tcpLatencyPromise;
            if (settled) return;
            const latencyMs = Number.isFinite(measuredLatency) ? measuredLatency : null;
    
            // Parse the output
            const output = stdout.trim().replace(new RegExp(`^${latencyMarker}\\|?`), '');
    
            // Unsupported OS — stop polling this session
            if (output.startsWith('UNSUPPORTED_OS:')) {
              settle({ success: false, error: `Server stats not supported on this OS (${output.substring(15)})` });
              return;
            }
    
            const parts = output.split('|');
    
            let cpuDirect = null;    // macOS: direct CPU percentage from top
            let cpuRawTotal = null;
            let cpuRawIdle = null;
            let cpuPerCoreRaw = [];  // Array of { total, idle }
            let cpuCores = null;
            let memTotal = null;
            let memFree = null;
            let memBuffers = null;
            let memCached = null;
            let memUsed = null;
            let swapTotal = null;
            let swapUsed = null;
            let topProcesses = [];  // Array of { pid, memPercent, command }
            let disks = [];  // Array of { mountPoint, used, total, percent }
            let networkInterfaces = [];  // Array of { name, rxBytes, txBytes }
            let hostname = "";
            let osName = "";
            let kernelRelease = "";
            let uptimeSeconds = null;
            let loadAverage = [];
    
            for (const part of parts) {
              if (part.startsWith('CPU:')) {
                // macOS: command reports normalized CPU% directly (no delta needed)
                const val = parseFloat(part.substring(4).trim());
                if (!isNaN(val)) cpuDirect = Math.min(100, Math.max(0, Math.round(val)));
              } else if (part.startsWith('CPURAW:')) {
                const rawParts = part.substring(7).trim().split(/\s+/);
                if (rawParts.length >= 2) {
                  cpuRawTotal = parseInt(rawParts[0], 10);
                  cpuRawIdle = parseInt(rawParts[1], 10);
                }
              } else if (part.startsWith('CORES:')) {
                const coreStr = part.substring(6).trim();
                const val = parseInt(coreStr, 10);
                if (!isNaN(val) && val > 0) cpuCores = val;
              } else if (part.startsWith('PERCORERAW:')) {
                const coreStr = part.substring(11).trim();
                if (coreStr && coreStr !== '') {
                  cpuPerCoreRaw = coreStr.split(',').map(v => {
                    const coreParts = v.trim().split(':');
                    if (coreParts.length >= 2) {
                      const total = parseInt(coreParts[0], 10);
                      const idle = parseInt(coreParts[1], 10);
                      if (!isNaN(total) && !isNaN(idle)) {
                        return { total, idle };
                      }
                    }
                    return null;
                  }).filter(v => v !== null);
                }
              } else if (part.startsWith('MEMINFO:')) {
                const memParts = part.substring(8).trim().split(/\s+/);
                if (memParts.length >= 4) {
                  const total = parseInt(memParts[0], 10);
                  const free = parseInt(memParts[1], 10);
                  const buffers = parseInt(memParts[2], 10);
                  const cached = parseInt(memParts[3], 10);
                  if (!isNaN(total)) memTotal = total;
                  if (!isNaN(free)) memFree = free;
                  if (!isNaN(buffers)) memBuffers = buffers;
                  if (!isNaN(cached)) memCached = cached;
                  // Calculate used memory (excluding buffers/cache)
                  if (memTotal !== null && memFree !== null && memBuffers !== null && memCached !== null) {
                    memUsed = memTotal - memFree - memBuffers - memCached;
                    if (memUsed < 0) memUsed = 0;
                  }
                  // Parse swap info (fields 5 and 6)
                  if (memParts.length >= 6) {
                    const st = parseInt(memParts[4], 10);
                    const sf = parseInt(memParts[5], 10);
                    if (!isNaN(st)) swapTotal = st;
                    if (!isNaN(sf)) {
                      swapUsed = (swapTotal !== null) ? swapTotal - sf : null;
                      if (swapUsed !== null && swapUsed < 0) swapUsed = 0;
                    }
                  }
                }
              } else if (part.startsWith('PROCS:')) {
                const procsStr = part.substring(6).trim();
                if (procsStr && procsStr !== '') {
                  const procEntries = procsStr.split(',');
                  for (const entry of procEntries) {
                    const procParts = entry.split(';');  // Using ; as delimiter
                    if (procParts.length >= 3) {
                      const pid = procParts[0];
                      const memPercent = parseFloat(procParts[1]);
                      const command = procParts.slice(2).join(';');  // Command might contain semicolons
                      if (!isNaN(memPercent)) {
                        topProcesses.push({ pid, memPercent, command });
                      }
                    }
                  }
                }
              } else if (part.startsWith('DISKS:')) {
                const disksStr = part.substring(6).trim();
                if (disksStr && disksStr !== '') {
                  const diskEntries = disksStr.split(',');
                  for (const entry of diskEntries) {
                    const diskParts = entry.split(':');
                    if (diskParts.length >= 4) {
                      const mountPoint = diskParts[0];
                      const used = parseFloat(diskParts[1]);
                      const total = parseFloat(diskParts[2]);
                      const percent = parseInt(diskParts[3], 10);
                      if (!isNaN(used) && !isNaN(total) && !isNaN(percent)) {
                        const capacityKey = diskParts.slice(4).join(':').trim();
                        disks.push({
                          mountPoint,
                          used,
                          total,
                          percent,
                          ...(capacityKey ? { capacityKey } : {}),
                        });
                      }
                    }
                  }
                }
              } else if (part.startsWith('NET:')) {
                const netStr = part.substring(4).trim();
                if (netStr && netStr !== '') {
                  const netEntries = netStr.split(',');
                  for (const entry of netEntries) {
                    const netParts = entry.split(':');
                    if (netParts.length >= 3) {
                      const name = netParts[0];
                      const rxBytes = parseInt(netParts[1], 10);
                      const txBytes = parseInt(netParts[2], 10);
                      if (!isNaN(rxBytes) && !isNaN(txBytes)) {
                        networkInterfaces.push({ name, rxBytes, txBytes });
                      }
                    }
                  }
                }
              } else if (part.startsWith('HOST:')) {
                hostname = part.substring(5).trim();
              } else if (part.startsWith('OS:')) {
                osName = part.substring(3).trim();
              } else if (part.startsWith('KERNEL:')) {
                kernelRelease = part.substring(7).trim();
              } else if (part.startsWith('UPTIME:')) {
                const uptimeText = part.substring(7).trim();
                if (uptimeText !== '') {
                  const uptime = Number(uptimeText);
                  if (Number.isFinite(uptime) && uptime >= 0) uptimeSeconds = uptime;
                }
              } else if (part.startsWith('LOAD:')) {
                const loadText = part.substring(5).trim();
                if (loadText !== '') {
                  loadAverage = loadText.split(/\s+/)
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value) && value >= 0)
                    .slice(0, 3);
                }
              }
            }
    
            // Calculate network speed based on previous reading
            const now = Date.now();
            const prevNet = session.prevNetStats || { interfaces: [], timestamp: 0 };
            const timeDelta = (now - prevNet.timestamp) / 1000; // seconds
    
            let netRxSpeed = 0;  // bytes per second
            let netTxSpeed = 0;  // bytes per second
            const netInterfaces = [];
    
            if (timeDelta > 0 && prevNet.interfaces.length > 0) {
              for (const iface of networkInterfaces) {
                const prevIface = prevNet.interfaces.find(p => p.name === iface.name);
                if (prevIface) {
                  const rxDelta = iface.rxBytes - prevIface.rxBytes;
                  const txDelta = iface.txBytes - prevIface.txBytes;
                  // Only count positive deltas (handles counter reset)
                  const rxSpeed = rxDelta > 0 ? Math.round(rxDelta / timeDelta) : 0;
                  const txSpeed = txDelta > 0 ? Math.round(txDelta / timeDelta) : 0;
                  netRxSpeed += rxSpeed;
                  netTxSpeed += txSpeed;
                  netInterfaces.push({
                    name: iface.name,
                    rxBytes: iface.rxBytes,
                    txBytes: iface.txBytes,
                    rxSpeed,
                    txSpeed,
                  });
                } else {
                  netInterfaces.push({
                    name: iface.name,
                    rxBytes: iface.rxBytes,
                    txBytes: iface.txBytes,
                    rxSpeed: 0,
                    txSpeed: 0,
                  });
                }
              }
            } else {
              // First reading - no speed data yet
              for (const iface of networkInterfaces) {
                netInterfaces.push({
                  name: iface.name,
                  rxBytes: iface.rxBytes,
                  txBytes: iface.txBytes,
                  rxSpeed: 0,
                  txSpeed: 0,
                });
              }
            }
    
            // Store current reading for next calculation
            session.prevNetStats = {
              interfaces: networkInterfaces,
              timestamp: now,
            };
    
            // Calculate CPU usage based on delta from previous reading
            const prevCpu = session.prevCpuStats || { total: 0, idle: 0, perCore: [], timestamp: 0 };
            let cpu = null;
            let cpuPerCore = [];
    
            if (cpuRawTotal !== null && cpuRawIdle !== null && prevCpu.total > 0) {
              const totalDelta = cpuRawTotal - prevCpu.total;
              const idleDelta = cpuRawIdle - prevCpu.idle;
              if (totalDelta > 0) {
                // CPU% = 100 - (idleDelta / totalDelta * 100)
                cpu = Math.round(100 - (idleDelta / totalDelta * 100));
                // Clamp to valid range
                if (cpu < 0) cpu = 0;
                if (cpu > 100) cpu = 100;
              }
            }
    
            // macOS: use direct percentage from top (no delta needed)
            if (cpu === null && cpuDirect !== null) {
              cpu = cpuDirect;
            }
    
            // Calculate per-core CPU usage from deltas
            if (cpuPerCoreRaw.length > 0 && prevCpu.perCore.length > 0) {
              cpuPerCore = cpuPerCoreRaw.map((core, index) => {
                const prevCore = prevCpu.perCore[index];
                if (prevCore) {
                  const totalDelta = core.total - prevCore.total;
                  const idleDelta = core.idle - prevCore.idle;
                  if (totalDelta > 0) {
                    let usage = Math.round(100 - (idleDelta / totalDelta * 100));
                    if (usage < 0) usage = 0;
                    if (usage > 100) usage = 100;
                    return usage;
                  }
                }
                return 0;
              });
            } else if (cpuPerCoreRaw.length > 0) {
              // First reading - no delta data yet, return zeros
              cpuPerCore = cpuPerCoreRaw.map(() => 0);
            }
    
            // Store current CPU reading for next calculation
            session.prevCpuStats = {
              total: cpuRawTotal || 0,
              idle: cpuRawIdle || 0,
              perCore: cpuPerCoreRaw,
              timestamp: now,
            };
    
            // For backward compatibility, extract root disk info
            const rootDisk = disks.find(d => d.mountPoint === '/');
            const diskPercent = rootDisk ? rootDisk.percent : null;
            const diskUsed = rootDisk ? rootDisk.used : null;
            const diskTotal = rootDisk ? rootDisk.total : null;
    
            // If no meaningful data was parsed, treat as failure to stop futile polling
            if (cpu === null && memTotal === null && cpuCores === null) {
              settle({ success: false, error: 'Unable to parse server stats (unsupported OS or shell)' });
              return;
            }
    
            settle({
              success: true,
              stats: {
                cpu,           // CPU usage percentage (0-100)
                cpuCores,      // Number of CPU cores
                cpuPerCore,    // Per-core CPU usage array
                memTotal,      // Total memory in MB
                memUsed,       // Used memory in MB (excluding buffers/cache)
                memFree,       // Free memory in MB
                memBuffers,    // Buffers in MB
                memCached,     // Cached in MB
                swapTotal,     // Swap total in MB
                swapUsed,      // Swap used in MB
                topProcesses,  // Top 10 processes by memory
                diskPercent,   // Disk usage percentage for root partition (backward compat)
                diskUsed,      // Disk used in GB for root partition (backward compat)
                diskTotal,     // Total disk in GB for root partition (backward compat)
                disks,         // Array of all mounted disks
                netRxSpeed,    // Total network receive speed (bytes/sec)
                netTxSpeed,    // Total network transmit speed (bytes/sec)
                latencyMs,      // TCP connection establishment latency to the SSH endpoint (ms)
                netInterfaces, // Per-interface network stats
                hostname,
                osName,
                kernelRelease,
                uptimeSeconds,
                loadAverage,
              },
            });
          });

        });
      });
    }
    
    /**
     * Set terminal encoding for an active SSH session
     */
    async function setSessionEncoding(_event, { sessionId, encoding }) {
      const session = sessions?.get(sessionId);
      if (!session || !session.stream) {
        return { ok: false, encoding: encoding || "utf-8" };
      }
      const enc = normalizeTerminalEncoding(encoding);
      if (!iconv.encodingExists(enc)) {
        return { ok: false, encoding: enc };
      }
      sessionEncodings.set(sessionId, enc);
      // Mirror onto the session record so the terminal input path
      // (terminalBridge.writeToSession) encodes keystrokes with the same
      // charset the output decoder now uses — keeping input/output symmetric
      // on non-UTF-8 devices (issue #1216).
      session.encoding = enc;
      // Reset stateful decoders so new data uses the updated encoding
      resetSessionDecoders(sessionId);
      return { ok: true, encoding: enc };
    }

    return {
      getSessionRemoteInfo,
      getSessionDistroInfo,
      readRemoteHistory,
      getSessionPwd,
      probeReceiveConflicts,
      removeRemoteFiles,
      restoreRemoteModes,
      listSessionDir,
      getServerStats,
      setSessionEncoding,
    };
  }
}

module.exports = { createSessionOpsApi, decodeLsofFileName };
