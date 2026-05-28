/* eslint-disable no-undef */
function createSessionOpsApi(ctx) {
  with (ctx) {
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
    
    async function getSessionPwd(event, payload) {
      const { sessionId } = payload;
      const session = sessions.get(sessionId);
    
      if (!session || !session.conn) {
        return { success: false, error: 'Session not found or not connected' };
      }
    
      // Completely silent: uses a separate exec channel, nothing is printed
      // in the interactive terminal. The exec channel and the interactive
      // shell are both children of the same per-connection sshd process,
      // so we find the shell as a sibling via $PPID.
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ success: false, error: 'Timeout getting pwd' });
        }, 5000);
    
        // POSIX sh script that:
        //   1. Finds the user's interactive shell on the same SSH connection
        //      (sibling under $PPID on newer OpenSSH, cousin reachable via the
        //      shared SSH_CONNECTION env var on older OpenSSH like CentOS 7).
        //   2. Follows foreground child shells only, which covers bash->fish
        //      without mistaking background shell scripts for the active shell.
        //   3. Reads /proc/<pid>/cwd via readlink.
        //   4. Falls back to the user's home directory if anything fails.
        //
        // `exec` makes sh replace the user's login shell (fish/bash/...)
        // so sh keeps the same PID and $PPID = sshd. Starting another shell
        // without exec would make $PPID point at the intermediate shell instead.
        const posixScript = `SELF=$$
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
        $1 != self && $2 == pp && $4 ~ /^-?(ba|z|fi|k|da|a)?sh$/ {
          if ($3 != "?") { print $1; found=1; exit }
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
    login=$(find_login_shell "$PPID")
    if [ -n "$login" ]; then
      pid=$(find_active_shell "$login")
      [ -n "$pid" ] || pid="$login"
      cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
      # /proc/<pid>/cwd is only readable for same-uid processes (ptrace perms), so
      # this unprivileged exec channel cannot read a su'd / sudo'd shell owned by
      # another user. Fall back to the same-uid login shell's cwd before giving up
      # to the home directory (#1065 review).
      if [ -z "$cwd" ] && [ "$pid" != "$login" ]; then
        cwd=$(readlink /proc/$login/cwd 2>/dev/null)
      fi
      [ -n "$cwd" ] && printf '%s\\n' "$cwd" && exit 0
    fi
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
    
        session.conn.exec(cmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            log('[getSessionPwd] exec error:', err.message);
            resolve({ success: false, error: err.message });
            return;
          }
          let out = '';
          let errOut = '';
          stream.on('data', (d) => { out += d.toString(); });
          stream.stderr?.on('data', (d) => { errOut += d.toString(); });
          stream.on('close', (code) => {
            clearTimeout(timer);
            const path = out.trim();
            log('[getSessionPwd]', { stdout: path, stderr: errOut.trim(), exitCode: code });
            if (path && path.startsWith('/')) {
              resolve({ success: true, cwd: path });
            } else {
              resolve({ success: false, error: 'Could not determine cwd' });
            }
          });
        });
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
    
      if (!session || !session.conn) {
        return { success: false, error: 'Session not found or not connected' };
      }
    
      const conn = session.conn;
    
      // macOS stats command: uses sysctl, vm_stat, top, ps, df, netstat
      // CPU reported as direct percentage (top computes delta internally)
      // cpuPerCore not available on macOS without sudo
      const macosStatsCommand = [
        `cores=$(sysctl -n hw.logicalcpu 2>/dev/null || echo "1")`,
        `pagesize=$(sysctl -n hw.pagesize 2>/dev/null || echo "4096")`,
        `memsize=$(sysctl -n hw.memsize 2>/dev/null || echo "0")`,
        // CPU usage: top -l 1 gives one logging sample, parse idle%
        `cpuline=$(top -l 1 -s 0 -n 0 2>/dev/null | grep "CPU usage:" | head -1)`,
        `cpupct=$(echo "$cpuline" | awk '{for(i=1;i<=NF;i++){if($(i+1)~/^idle/){v=$i;gsub(/%/,"",v);idle=v+0;found=1}};if(found)printf "%.0f",100-idle}')`,
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
        // Disk: only show root "/" and external volumes "/Volumes/*", skip system APFS snapshots
        `disks=$(df -k 2>/dev/null | awk 'NR>1&&index($1,"/dev/")==1&&NF>=9&&($NF=="/"||index($NF,"/Volumes/")==1){u=$3/1048576;t=$2/1048576;p=$5;gsub(/%/,"",p);printf "%s:%.0f:%.0f:%s,",$NF,u,t,p}' | sed 's/,$//')`,
        // Network: Link# lines only, exclude loopback, detect column shift (no MAC addr → cols shift left)
        `net=$(netstat -ib 2>/dev/null | awk '/^[a-z]/&&$3~/Link/&&$1!~/^lo/{if($4~/:/){rx=$7;tx=$10}else{rx=$6;tx=$9};if((rx+0)>0){gsub(/[*]/,"",$1);printf "%s:%s:%s,",$1,rx,tx}}' | sed 's/,$//')`,
        `echo "CPU:$cpupct|CORES:$cores|MEMINFO:$memtotal $memfree 0 $memcached $swaptotal $swapfree|PROCS:$procs|DISKS:$disks|NET:$net"`,
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
        // BusyBox fallback: ps -o pid,vsz,comm and sort manually (BusyBox ps doesn't have %mem, use vsz instead)
        `procs=$(ps -eo pid,%mem,comm --sort=-%mem 2>/dev/null | awk 'NR>1 && NR<=11 {gsub(/;/, "_", $3); printf "%s;%.1f;%s,", $1, $2, $3}' | sed 's/,$//' || ps -o pid,vsz,comm 2>/dev/null | awk 'NR>1 {gsub(/;/, "_", $3); print $2, $1, $3}' | sort -rn | head -10 | awk -v total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo) '{if(total>0) pct=$1*100/total; else pct=0; printf "%s;%.1f;%s,", $2, pct, $3}' | sed 's/,$//' || echo "")`,
        // Get all mounted disk info - with BusyBox fallback
        // GNU df: df -BG (block size in GB)
        // BusyBox fallback: df and calculate from 1K blocks, or df -h and parse units
        `disks=$(df -BG 2>/dev/null | awk 'NR>1 && $1 ~ /^\\/dev/ {gsub(/G/,"",$2); gsub(/G/,"",$3); gsub(/%/,"",$5); printf "%s:%s:%s:%s,", $6, $3, $2, $5}' | sed 's/,$//' || df 2>/dev/null | awk 'NR>1 && $1 ~ /^\\/dev/ {total=$2/1048576; used=$3/1048576; pct=$5; gsub(/%/,"",pct); printf "%s:%.0f:%.0f:%s,", $6, used, total, pct}' | sed 's/,$//' || echo "")`,
        // Get network interface stats from /proc/net/dev (interface:rx_bytes:tx_bytes), excluding lo and virtual interfaces
        `net=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 {gsub(/^[ \\t]+/, ""); split($0, a, ":"); iface=a[1]; if(iface != "lo" && iface !~ /^veth/ && iface !~ /^docker/ && iface !~ /^br-/) {split(a[2], b); printf "%s:%s:%s,", iface, b[1], b[9]}}' | sed 's/,$//' || echo "")`,
        // Output all stats (using CPURAW and PERCORERAW instead of CPU and PERCORE)
        `echo "CPURAW:$cpuraw|CORES:$cores|PERCORERAW:$percoreraw|MEMINFO:$meminfo|PROCS:$procs|DISKS:$disks|NET:$net"`
      ].join('; ');
    
      // Auto-detect OS via uname — only Linux and macOS are supported
      const statsCommand = `ostype=$(uname -s 2>/dev/null || echo "Unknown"); if [ "$ostype" = "Darwin" ]; then ${macosStatsCommand}; elif [ "$ostype" = "Linux" ]; then ${linuxStatsCommand}; else echo "UNSUPPORTED_OS:$ostype"; fi`;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Timeout getting server stats' });
        }, 5000);
    
        conn.exec(statsCommand, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message });
            return;
          }
    
          let stdout = '';
          let stderr = '';
    
          stream.on('data', (data) => {
            stdout += data.toString();
          });
    
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
    
          stream.on('close', () => {
            clearTimeout(timeout);
    
            // Parse the output
            const output = stdout.trim();
    
            // Unsupported OS — stop polling this session
            if (output.startsWith('UNSUPPORTED_OS:')) {
              resolve({ success: false, error: `Server stats not supported on this OS (${output.substring(15)})` });
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
    
            for (const part of parts) {
              if (part.startsWith('CPU:')) {
                // macOS: top reports CPU% directly (no delta needed)
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
                      const used = parseInt(diskParts[1], 10);
                      const total = parseInt(diskParts[2], 10);
                      const percent = parseInt(diskParts[3], 10);
                      if (!isNaN(used) && !isNaN(total) && !isNaN(percent)) {
                        disks.push({ mountPoint, used, total, percent });
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
              resolve({ success: false, error: 'Unable to parse server stats (unsupported OS or shell)' });
              return;
            }
    
            resolve({
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
                netInterfaces, // Per-interface network stats
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
      const enc = String(encoding || "utf-8").toLowerCase();
      if (!iconv.encodingExists(enc)) {
        return { ok: false, encoding: enc };
      }
      sessionEncodings.set(sessionId, enc);
      // Reset stateful decoders so new data uses the updated encoding
      resetSessionDecoders(sessionId);
      return { ok: true, encoding: enc };
    }

    return {
      getSessionRemoteInfo,
      getSessionDistroInfo,
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

module.exports = { createSessionOpsApi };
