"use strict";

const {
  buildBashHistoryCleanup,
  bashHistoryCleanupStatusVar,
} = require("./ptyExecHelpers.cjs");

// Both fish and POSIX shells accept this command. Inspect the parent of a
// short-lived sh in the interactive PTY, rather than the SSH login shell.
function buildLiveShellProbe(marker) {
  const script = 'if test -r "/proc/$PPID/comm"; then IFS= read -r name < "/proc/$PPID/comm"; else name=$(ps -p "$PPID" -o comm= 2>/dev/null); fi; '
    + `printf "${marker}_P:%s\\n" "$name"`;
  // Run cleanup independently of process-name detection or external sh/PATH.
  // A user alias or function can shadow any single dispatcher name, so the
  // cleanup is dispatched through both \command eval and \builtin eval: the
  // one that reaches the real eval runs the cleanup, the other no-ops once
  // the marker is already gone; cleanup itself checks BASH_VERSION.
  // The \builtin eval fallback only runs when the \command eval path left the
  // cleanup's verified-deletion flag unset (shadowed dispatcher or nothing to
  // verify); a slow shadowed fallback (e.g. builtin() { sleep 60; }) is
  // therefore not invoked again after a real dispatcher already deleted the
  // entry. The eval'd cleanup leaves the flag (holding only "1") set in the
  // interactive shell, so the test reads it through eval: the quoted
  // ${flag-} default keeps the expansion nounset-safe in POSIX shells (a bare
  // $flag aborts dash under set -u), and the flag can never be a secret.
  // Fish rejects ${...} inside the eval'd test, which only fails that segment
  // (non-zero) so the fallback runs and no-ops there as before.
  // Fish cannot resolve eval through command and rejects it without parsing its
  // quoted POSIX body. Make cleanup failure non-fatal even under set -e,
  // suppress its diagnostic, and always emit Q afterward.
  // Put the job marker near the start of the echo, as the existing wrappers
  // do, so preload can suppress it before a long command is split into chunks.
  // The builtin completion marker still runs if sh cannot launch. Leave it
  // unterminated so preload hides the intermediate prompt and wrapper echo
  // on the same marker-bearing line, including across output chunks.
  const cleanup = buildBashHistoryCleanup(marker, true);
  const cleanupStatus = bashHistoryCleanupStatusVar(marker);
  // "${var-}" is written via concatenation: inside a template literal "\${"
  // would escape the interpolation and emit the literal name instead.
  const statusTest = `eval '[ -n "$` + `{${cleanupStatus}-}" ]' 2>/dev/null`;
  return ` true ${marker}; command sh -c '${script}' 2>/dev/null; \\command eval '${cleanup}' 2>/dev/null || true; ${statusTest} || \\builtin eval '${cleanup}' 2>/dev/null || true; printf '%s' '${marker}_Q'\n`;
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
