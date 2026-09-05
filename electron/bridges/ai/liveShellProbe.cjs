"use strict";

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the *interactive* PTY, rather than the SSH login shell.
// No greeting, prompt, or cached output is evidence of the active shell.
function buildLiveShellProbe(marker) {
  const script = `: ${marker}; ` + 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "${marker}_P:%s\\n" "$name"`;
  return ` command sh -c '${script}'\n`;
}

function parseLiveShellProbe(output, marker) {
  // A complete response line excludes the terminal's echoed probe command.
  for (const line of String(output).replace(/\r/g, "\n").split("\n").slice(0, -1)) {
    if (!line.startsWith(`${marker}_P:`)) continue;
    const name = line.slice(marker.length + 3).trim().split("/").pop().replace(/^-/, "");
    return {
      kind: name === "fish" ? "fish"
        : /^(?:ba|da|z|k|a)?sh$/.test(name) ? "posix" : null,
    };
  }
  return null;
}

module.exports = { buildLiveShellProbe, parseLiveShellProbe };
