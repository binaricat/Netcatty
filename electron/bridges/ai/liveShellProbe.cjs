"use strict";

const { buildBashHistoryCleanup, bashHistoryScratchNames } = require("./ptyExecHelpers.cjs");

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the interactive PTY, rather than the SSH login shell.
function buildLiveShellProbe(marker, posixFlavor = "") {
  const script = 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "${marker}_P:%s\\n" "$name"`;
  // zsh flavor (#3575): the Bash-only history cleanup below is a runtime no-op
  // in zsh (BASH_VERSION guard), so a zsh session only pays for its multiline
  // `\<newline>` continuations being parsed and redisplayed by the busy line
  // editor. Type the entire probe as a single physical line instead: no PS2
  // continuations and no mid-construct split points. Unknown flavors use the
  // same zsh-safe single-line form: when no zsh path hint exists yet (e.g. a
  // single-channel SSH session where the session shell probe is unavailable,
  // or a bash-configured session that entered zsh), the first probe would
  // otherwise still type the multiline cleanup probe before live detection
  // can rule zsh out, wedging the busy zsh line editor. The single-line form
  // is a valid probe in every other candidate shell (bash only loses the
  // probe-line history cleanup for that one job), and once the live probe
  // reports a bash shell the remembered flavor restores the multiline form
  // with its cleanup.
  if (posixFlavor !== "bash") {
    // Start display suppression in the PTY before the single long line is
    // read, independently of PS2 and echo mode.
    // Space-prefix every physical line (zsh only records unprefixed lines
    // when the user enables HIST_IGNORE_SPACE), matching the Bash branch.
    return ` true ${marker}; printf '\\n%s\\n' '${marker}_I'\n : '${marker}'; command sh -c '${script}' 2>/dev/null; printf '%s' '${marker}_Q'\n`;
  }
  // command eval bypasses an eval customization; plain eval is the fallback
  // when command itself is shadowed. Never invoke a shadowed builtin after the
  // command path already succeeded. Both eval bodies remain Bash-guarded.
  const cleanup = buildBashHistoryCleanup(marker, true);
  const { dispatcher } = bashHistoryScratchNames(marker);
  const clear = `[ -z "\${${dispatcher}-}" ]||$${dispatcher} unset ${dispatcher}`;
  const fallback = `[ "\${${dispatcher}-}" = command ]||{ ${cleanup}; };${clear}`;
  // Start display suppression in the PTY before any continuation is read,
  // independently of PS2 and echo mode. Keep every later physical line short.
  return ` true ${marker}; printf '\\n%s\\n' '${marker}_I'\n : '${marker}'; command sh -c '${script}' 2>/dev/null; \\\n: '${marker}'; \\command eval '${cleanup}' 2>/dev/null || true; \\\n: '${marker}'; \\eval '${fallback}' 2>/dev/null || true; \\\n: '${marker}'; \\command eval '${clear}' 2>/dev/null || true; printf '%s' '${marker}_Q'\n`;

}

// Interactive bash prints PS2 (`> ` by default) on backslash continuations.
// Strip that prefix (and other common prompt leftovers) so `_Q` / `_P:`
// sentinels still parse when the probe is not a single physical line.
function normalizeLiveShellProbeLine(line) {
  return String(line).replace(/^[>#$%\s]+/, "");
}

// `shellName` is the raw comm name of the interactive shell's sh child's
// parent (path + login-dash stripped), so the exec pipeline can pick a
// shell-flavored wrapper (currently the zsh single-line wrapper, #3575)
// while `kind` keeps the coarse fish/posix classification.
function parseLiveShellProbe(output, marker) {
  const lines = String(output).replace(/\r/g, "\n").split("\n");
  if (!lines.some((line) => normalizeLiveShellProbeLine(line).startsWith(`${marker}_Q`))) return null;
  for (const line of lines) {
    const normalized = normalizeLiveShellProbeLine(line);
    if (!normalized.startsWith(`${marker}_P:`)) continue;
    const name = normalized.slice(marker.length + 3).trim().split("/").pop().replace(/^-/, "");
    return {
      kind: name === "fish" ? "fish"
        // Versioned zsh basenames (e.g. Homebrew "zsh-5.9") share the plain
        // "zsh" basename's POSIX classification, mirroring
        // posixFlavorFromShellPath(). Otherwise a fish login-shell hint would
        // survive refinement and later type fish syntax into zsh.
        : /^(?:ba|da|z|k|a)?sh$/.test(name) || /^zsh([-.][0-9][^/]*)?$/i.test(name)
          ? "posix" : null,
      shellName: name,
    };
  }
  return { kind: null, shellName: "" };
}

module.exports = { buildLiveShellProbe, parseLiveShellProbe, normalizeLiveShellProbeLine };
