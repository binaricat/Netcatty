import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import { shouldProbeCommandCwd } from "./commandCwdProbe";
import { scheduleBackendCwdProbeAfterCommand } from "../terminal/sftpCwd";
import { buildOsc7SetupCommand } from "../terminal/osc7Setup";
import {
  consumeOsc133CommandCompletion,
  consumeOsc133CwdCompletion,
  consumeTerminalCwdRepublish,
  createPromptLineBreakState,
  detectTerminalCommandCompletions,
  drainTerminalCwdCompletions,
  markOsc133CompletionProtocol,
  markTerminalCommandCompletionPending,
  markTerminalCwdCompletionPending,
} from "../terminal/runtime/promptLineBreak";

// Execute the actual parent callbacks, without mounting the rest of the app.
const source = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");
const callbacks = source.slice(source.indexOf("  const handleCommandSubmitted ="), source.indexOf("  const handleCommandExecuted ="));
const makeCallbacks = new Function("ctx", transformSync(`
  const { useCallback, codingCliSignalController, cwdProbeGenerationRef,
    cwdProbeCancelersRef, cwdProbeCommandSignalRef, activeTabIdRef, sessionsRef,
    canReuseTerminalConnection, sessionHostsMapRef, sidePanelLayoutHasTool,
    sidePanelLayoutsRef, sftpHostForTabRef, shouldProbeCommandCwd, restoreTerminalCwd,
    sftpFollowTerminalCwdRef, hostRestrictsExtraSshChannels, terminalOsc7SignalBySessionRef,
    scheduleBackendCwdProbeAfterCommand, terminalBackend, classifyDistroId,
    shouldProbeSessionCwd, handleTerminalCwdChange } = ctx;
  ${callbacks}
  return { submitted: handleCommandSubmitted, completed: handleCommandCompleted };
`, { loader: "ts", target: "es2022" }).code);

const waitUntil = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture shell did not reach the expected prompt/cwd");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

for (const mode of ["osc133", "osc7", "prompt"]) {
  const integration = mode === "osc7";
  test(`Bash follows completed cwd changes, no-op and failed cd using ${mode}`, {
    skip: process.platform !== "linux",
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "netcatty-cwd-completion-"));
    const first = join(home, "one");
    const second = join(home, "two");
    mkdirSync(first); mkdirSync(second);
    const rc = join(home, ".bashrc");
    const promptMarker = "__NETCATTY_FIXTURE_PROMPT__$ ";
    const firstGate = join(home, "release-first");
    const finalGate = join(home, "release-final");
    const env = { ...process.env, HOME: home, SHELL: "/bin/bash", PS1: "$ ", HISTFILE: "/dev/null" };
    if (integration) execFileSync("/bin/sh", ["-c", buildOsc7SetupCommand()], { env, stdio: "pipe" });
    const configured = (integration ? readFileSync(rc, "utf8") : "") + `\nPS1='${promptMarker}'\n`;
    // OSC 133 is the existing runtime completion protocol, independent of cwd.
    writeFileSync(rc, mode === "prompt" ? configured : `${configured}\nPROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND}; }printf '\\033]133;D\\a'"\n`);
    const shell = spawn("/bin/bash", ["--noprofile", "--rcfile", rc, "-i"], { cwd: home, env, stdio: "pipe" });
    let ready = false;
    let received = "";
    let prompts = "";
    let cwd: string | null = null;
    let cwdSource: string | undefined;
    let probes = 0;
    let completions = 0;
    const signals = { current: new Map<string, number>() };
    const cancelers = { current: new Map<string, () => void>() };
    const pending = { current: createPromptLineBreakState() };
    const { submitted, completed } = makeCallbacks({
      useCallback: (callback: unknown) => callback,
      codingCliSignalController: { handleCommandSubmitted() {} },
      cwdProbeGenerationRef: { current: new Map() }, cwdProbeCancelersRef: cancelers,
      cwdProbeCommandSignalRef: { current: new Map() },
      activeTabIdRef: { current: "session" }, sessionsRef: { current: [{ id: "session" }] },
      canReuseTerminalConnection: () => true,
      sessionHostsMapRef: { current: new Map([["session", { sftpFollowTerminalCwd: true }]]) },
      sidePanelLayoutHasTool: () => true, sidePanelLayoutsRef: { current: new Map() },
      sftpHostForTabRef: { current: new Map([["session", { sftpFollowTerminalCwd: true }]]) },
      shouldProbeCommandCwd, restoreTerminalCwd: true, sftpFollowTerminalCwdRef: { current: true },
      hostRestrictsExtraSshChannels: () => false, terminalOsc7SignalBySessionRef: signals,
      scheduleBackendCwdProbeAfterCommand,
      terminalBackend: {
        getSessionRemoteInfo: async () => ({ remoteSshVersion: "OpenSSH_fixture" }),
        getSessionPwd: async () => {
          probes += 1;
          return { success: true, cwd: readlinkSync(`/proc/${shell.pid}/cwd`) };
        },
      },
      classifyDistroId: () => "linux", shouldProbeSessionCwd: () => true,
      handleTerminalCwdChange: (_session: string, path: string, meta?: { source?: string }) => {
        cwd = path;
        cwdSource = meta?.source;
      },
    });
    shell.stderr.on("data", (chunk: Buffer) => {
      if (mode !== "prompt") return;
      prompts += chunk.toString();
      // Pipes may split or coalesce real Bash prompts with command echo. Do
      // not lose a prompt just because it is not at the end of a data chunk.
      for (;;) {
        const end = prompts.indexOf(promptMarker);
        if (end < 0) break;
        prompts = prompts.slice(end + promptMarker.length);
        ready = true;
        completions += 1;
        const prompt = { buffer: { active: {
          cursorX: 2, cursorY: 0, baseY: 0,
          getLine: (line: number) => line === 0 ? { isWrapped: false, translateToString: () => "$ " } : undefined,
        } } };
        // Mirror the runtime fallback publication rules: only a single
        // outstanding command (or the armed re-check) confirms a cwd, and a
        // publication arms a one-shot re-check afterward. Prompt-shaped
        // evidence can be forged by command output, so every publication
        // stays untrusted.
        const count = detectTerminalCommandCompletions(prompt as never, pending.current);
        const cwdConfirmed = drainTerminalCwdCompletions(prompt as never, pending.current) && count <= 1;
        const republish = consumeTerminalCwdRepublish(prompt as never, pending.current);
        const publishCwd = (cwdConfirmed || republish) && count <= 1;
        if (publishCwd) {
          completed("session");
          if (cwdConfirmed || republish) {
            // Mirror the runtime arming rules: a fresh publication restarts
            // the re-check chain, a consumed re-check advances it, and the
            // chain is capped.
            const depth = republish ? pending.current.cwdRepublishDepth : 0;
            if (republish && depth >= 2) {
              pending.current.cwdRepublishDepth = 0;
            } else {
              pending.current.cwdRepublishDepth = depth + 1;
              pending.current.cwdRepublishPending = true;
            }
          }
        }
      }
    });
    shell.stdout.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      for (;;) {
        const end = received.indexOf("\x07");
        if (end < 0) break;
        const sequence = received.slice(0, end);
        received = received.slice(end + 1);
        const osc7 = sequence.includes("\x1b]7;") ? sequence.match(/file:\/\/[^/]*(.*)$/) : null;
        if (osc7) {
          signals.current.set("session", (signals.current.get("session") ?? 0) + 1);
          cwd = decodeURIComponent(osc7[1]);
        }
        if (sequence.endsWith("\x1b]133;D")) {
          ready = true;
          completions += 1;
          // Mirror the runtime: the OSC 133;D marker proves shell completion
          // integration and confirms the last outstanding cwd-invalidating
          // command. A child can print the marker verbatim, so the confirmed
          // publication stays untrusted and re-arms the re-check.
          markOsc133CompletionProtocol("D", pending.current);
          const cwdDone = consumeOsc133CwdCompletion("D", pending.current);
          consumeOsc133CommandCompletion("D", pending.current);
          if (cwdDone) {
            pending.current.cwdRepublishDepth = 1;
            pending.current.cwdRepublishPending = true;
            completed("session");
          }
        }
      }
    });
    const submit = (command: string) => {
      cwd = null; // The shared live cwd is invalidated at submission.
      markTerminalCommandCompletionPending(pending);
      markTerminalCwdCompletionPending(pending);
      pending.current.cwdRepublishPending = false;
      submitted(command, "host", "fixture", "session");
      shell.stdin.write(`${command}\n`);
    };
    try {
      await waitUntil(() => ready);
      submit(`while [ ! -f '${firstGate}' ]; do sleep 0.01; done; cd '${first}'`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(probes, 0, "no fixed post-submit polling while the command is still running");
      assert.equal(cwd, null);
      writeFileSync(firstGate, "release");
      await waitUntil(() => cwd === first);
      if (mode === "osc133") {
        assert.equal(cwdSource, "backend", "OSC 133;D-confirmed publications stay untrusted: a child can print the marker verbatim");
      } else if (mode === "prompt") {
        assert.equal(cwdSource, "backend", "prompt-shaped fallback publications stay untrusted");
      }
      for (const command of ["cd .", `cd '${home}/does-not-exist'`]) {
        submit(command);
        await waitUntil(() => cwd === first);
      }
      const before = probes;
      const completedBefore = completions;
      submit(`sleep 0.1 && cd '${home}'`);
      submit(`while [ ! -f '${finalGate}' ]; do sleep 0.01; done; cd '${second}'`);
      await waitUntil(() => completions === completedBefore + 1);
      if (!integration) assert.equal(probes, before, "queued commands must finish before the fallback read");
      writeFileSync(finalGate, "release");
      if (mode === "prompt") {
        await waitUntil(() => completions >= completedBefore + 2);
        assert.equal(probes, before, "ambiguous prompt batches must not guess a confirmed cwd");
        assert.equal(cwd, null, "wait for an explicit cwd report or Locate instead of publishing an intermediate path");
      } else {
        await waitUntil(() => cwd === second);
        assert.equal(probes - before, integration ? 0 : 1);
        assert.equal(probes, integration ? 0 : 4);
      }
      // A submission from an unconfirmed prompt (sftp> etc.) never reaches the
      // trusted plugin callback, yet its cwd invalidation must still publish
      // once the shell reports completion (Codex: arm cwd completion for every
      // invalidated submission).
      cwd = null;
      markTerminalCwdCompletionPending(pending);
      pending.current.cwdRepublishPending = false;
      submitted(`cd '${home}'`, "host", "fixture", "session");
      shell.stdin.write(`cd '${home}'\n`);
      await waitUntil(() => cwd === home);
    } finally {
      writeFileSync(firstGate, "release");
      writeFileSync(finalGate, "release");
      for (const cancel of cancelers.current.values()) cancel();
      shell.stdin.end("exit\n");
      await new Promise<void>((resolve) => shell.once("exit", () => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("completion re-probe replacement cancels the previous pending probe", () => {
  const scheduled: unknown[] = [];
  const cancelled = new Set<number>();
  const { submitted, completed } = makeCallbacks({
    useCallback: (callback: unknown) => callback,
    codingCliSignalController: { handleCommandSubmitted() {} },
    cwdProbeGenerationRef: { current: new Map<string, number>() },
    cwdProbeCancelersRef: { current: new Map<string, () => void>() },
    cwdProbeCommandSignalRef: { current: new Map<string, number>() },
    activeTabIdRef: { current: "session" },
    sessionsRef: { current: [{ id: "session" }] } as never,
    canReuseTerminalConnection: () => true,
    sessionHostsMapRef: { current: new Map([["session", { sftpFollowTerminalCwd: true }]]) } as never,
    sidePanelLayoutHasTool: () => true,
    sidePanelLayoutsRef: { current: new Map() } as never,
    sftpHostForTabRef: { current: new Map([["session", { sftpFollowTerminalCwd: true }]]) } as never,
    shouldProbeCommandCwd, restoreTerminalCwd: true, sftpFollowTerminalCwdRef: { current: true },
    hostRestrictsExtraSshChannels: () => false,
    terminalOsc7SignalBySessionRef: { current: new Map<string, number>() },
    scheduleBackendCwdProbeAfterCommand: (options: unknown) => {
      scheduled.push(options);
      return () => { cancelled.add(scheduled.indexOf(options)); };
    },
    terminalBackend: {
      getSessionRemoteInfo: async () => ({ remoteSshVersion: "OpenSSH_fixture" }),
      getSessionPwd: async () => ({ success: true, cwd: null }),
    },
    classifyDistroId: () => "linux", shouldProbeSessionCwd: () => true,
    handleTerminalCwdChange: () => {},
  });

  submitted("cd /tmp", "host", "fixture", "session");
  // A forged prompt confirms a fallback publication; the later real prompt
  // arms the re-probe. The replacement must cancel the still-pending probe so
  // only the newest backend read stays eligible under the same generation.
  completed("session");
  completed("session");
  completed("session");
  assert.equal(scheduled.length, 3, "each confirmed completion schedules a probe");
  assert.ok(cancelled.has(scheduled.indexOf(scheduled[0])) && cancelled.has(scheduled.indexOf(scheduled[1])), "every replaced probe is cancelled");
  assert.ok(!cancelled.has(scheduled.indexOf(scheduled[2])), "the newest probe stays eligible");
});
