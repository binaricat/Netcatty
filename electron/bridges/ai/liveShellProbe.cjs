"use strict";

const { buildBashHistoryCleanup, bashHistoryScratchNames } = require("./ptyExecHelpers.cjs");

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the interactive PTY, rather than the SSH login shell.
function buildLiveShellProbe(marker) {
  const script = 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "${marker}_P:%s\\n" "$name"`;
  // command eval bypasses an eval customization; plain eval is the fallback
  // when command itself is shadowed. Never invoke a shadowed builtin after the
  // command path already succeeded. Both eval bodies remain Bash-guarded.
  const cleanup = buildBashHistoryCleanup(marker, true);
  const { dispatcher } = bashHistoryScratchNames(marker);
  const clear = `[ -z "\${${dispatcher}-}" ]||$${dispatcher} unset ${dispatcher}`;
  const fallback = `[ "\${${dispatcher}-}" = command ]||{ ${cleanup}; };${clear}`;
  // Continuation lines stay within canonical input limits. Each echo carries
  // the marker so the renderer also hides continuation prompts.
  return ` true ${marker}; command sh -c '${script}' 2>/dev/null; \\\n: '${marker}'; \\command eval '${cleanup}' 2>/dev/null || true; \\\n: '${marker}'; \\eval '${fallback}' 2>/dev/null || true; \\\n: '${marker}'; \\command eval '${clear}' 2>/dev/null || true; printf '%s' '${marker}_Q'\n`;

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
