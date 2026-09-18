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
  // Start display suppression in the PTY before any continuation is read,
  // independently of PS2 and echo mode. Keep every later physical line short.
  return ` true ${marker}; printf '\\n%s\\n' '${marker}_I'\n : '${marker}'; command sh -c '${script}' 2>/dev/null; \\\n: '${marker}'; \\command eval '${cleanup}' 2>/dev/null || true; \\\n: '${marker}'; \\eval '${fallback}' 2>/dev/null || true; \\\n: '${marker}'; \\command eval '${clear}' 2>/dev/null || true; printf '%s' '${marker}_Q'\n`;

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

// Deadline fallback for a lost _Q sentinel: salvage the shell name from a
// complete _P line so the fallback wrapper matches the shell the probe
// actually detected instead of the pre-probe kind. Returns "fish", "posix",
// or null for the last complete _P line, or undefined when no _P line
// arrived (the caller then keeps the pre-probe shell kind).
function parsePartialLiveShellProbeKind(output, marker) {
  const lines = String(output).replace(/\r/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith(`${marker}_P:`)) continue;
    const name = line.slice(marker.length + 3).trim().split("/").pop().replace(/^-/, "");
    return name === "fish" ? "fish"
      : /^(?:ba|da|z|k|a)?sh$/.test(name) ? "posix" : null;
  }
  return undefined;
}

module.exports = { buildLiveShellProbe, parseLiveShellProbe, parsePartialLiveShellProbeKind };
