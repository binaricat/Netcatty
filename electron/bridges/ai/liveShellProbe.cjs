"use strict";

const { buildBashHistoryCleanup } = require("./ptyExecHelpers.cjs");

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the interactive PTY, rather than the SSH login shell.
function buildLiveShellProbe(marker) {
  const script = 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "${marker}_P:%s\\n" "$name"; name=\${name##*/}; name=\${name#-}; test "$name" = bash`;
  // The child reports whether the parent is Bash through its exit status.
  // Only Bash evaluates its history cleanup; the surrounding && syntax is
  // also accepted by fish and does not expand unset parent-shell variables.
  // Clean the probe before Q, including when no command follows cancellation.
  // Put the job marker near the start of the echo, as the existing wrappers
  // do, so preload can suppress it before a long command is split into chunks.
  // The builtin completion marker still runs if sh cannot launch. Leave it
  // unterminated so preload hides the intermediate prompt and wrapper echo
  // on the same marker-bearing line, including across output chunks.
  return ` true ${marker}; command sh -c '${script}' 2>/dev/null && builtin eval '${buildBashHistoryCleanup(marker)}'; printf '%s' '${marker}_Q'\n`;
}

function parseLiveShellProbe(output, marker) {
  const lines = String(output).replace(/\r/g, "\n").split("\n");
  if (!lines.some((line) => line.startsWith(`${marker}_Q`))) return null;
  for (const line of lines) {
    if (!line.startsWith(`${marker}_P:`)) continue;
    const name = line.slice(marker.length + 3).trim().split("/").pop().replace(/^-/, "");
    return {
      kind: name === "fish" ? "fish"
        : /^(?:ba|da|z|k|a)?sh$/.test(name) ? "posix" : null,
    };
  }
  return { kind: null };
}

module.exports = { buildLiveShellProbe, parseLiveShellProbe };
