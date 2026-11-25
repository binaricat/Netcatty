import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pty from "node-pty";

import type { Host, TerminalSession } from "../../../domain/models";
import { createLocalShellHost } from "../../../domain/localShellHost";
import { resolveTerminalSessionHost } from "../../../domain/terminalHostResolution";
import { shouldSuppressHostStartupCommandOnReconnect } from "../restoredSessionGate";
import { createTerminalSessionStarters } from "./createTerminalSessionStarters";
import { createMockTerminalBackend, createStarterContext, createTermStub } from "./testSupport/starterHarness";

const noop = () => {};

test("local session skips empty and whitespace-only host startup commands", async () => {
  for (const startupCommand of ["", "   ", "\n\t \r\n"]) {
    const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
    const terminalBackend = createMockTerminalBackend({
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sessionWrites.push({ id, data, automated: options?.automated });
      },
    });
    const ctx = createStarterContext({
      host: {
        id: "local-host",
        label: "Local",
        hostname: "localhost",
        username: "",
        protocol: "local",
        startupCommand,
      },
      terminalSettings: { startupCommandDelayMs: 0 },
      terminalBackend,
      startupCommand: undefined,
      promptLineBreakStateRef: undefined,
    });

    await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(sessionWrites, [], `expected no writes for ${JSON.stringify(startupCommand)}`);
  }
});

test("local session cancels pending host startup command if shell exits before delay elapses", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  let triggerExit: ((evt: { exitCode?: number }) => void) | undefined;
  const terminalBackend = createMockTerminalBackend({
    onSessionExit: (_id: string, cb: (evt: { exitCode?: number }) => void) => {
      triggerExit = cb;
      return noop;
    },
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
  });
  const ctx = createStarterContext({
    host: {
      id: "local-host",
      label: "Local",
      hostname: "localhost",
      username: "",
      protocol: "local",
      startupCommand: "echo should-not-run",
    },
    terminalSettings: { startupCommandDelayMs: 30 },
    terminalBackend,
    startupCommand: undefined,
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  triggerExit?.({ exitCode: 1 });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(sessionWrites, []);
});

test("local session cancels pending host startup command when boot signal aborts before delay elapses", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = createMockTerminalBackend({
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
  });
  const controller = new AbortController();
  const ctx = createStarterContext({
    host: {
      id: "local-host",
      label: "Local",
      hostname: "localhost",
      username: "",
      protocol: "local",
      startupCommand: "echo aborted",
    },
    terminalSettings: { startupCommandDelayMs: 30 },
    terminalBackend,
    startupCommand: undefined,
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never, {
    signal: controller.signal,
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(sessionWrites, []);
});

test("local session normalizes CRLF multi-line startup commands for paste and lineDelay modes", async () => {
  for (const mode of ["paste", "lineDelay"] as const) {
    const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
    const terminalBackend = createMockTerminalBackend({
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sessionWrites.push({ id, data, automated: options?.automated });
      },
    });
    const ctx = createStarterContext({
      host: {
        id: "local-win",
        label: "PowerShell",
        hostname: "localhost",
        username: "",
        protocol: "local",
        localShell: "powershell.exe",
        startupCommand: "cd C:\\work\r\nnpm run dev",
        startupCommandRunMode: mode,
      },
      terminalSettings: { startupCommandDelayMs: 0 },
      terminalBackend,
      startupCommand: undefined,
      promptLineBreakStateRef: undefined,
    });

    await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
    await new Promise((resolve) => setTimeout(resolve, 15));

    if (mode === "paste") {
      assert.deepEqual(sessionWrites, [{
        id: "local-session",
        data: "cd C:\\work\nnpm run dev\r",
        automated: true,
      }]);
    } else {
      assert.deepEqual(sessionWrites, [
        { id: "local-session", data: "cd C:\\work\r", automated: true },
        { id: "local-session", data: "npm run dev\r", automated: true },
      ]);
    }
  }
});

test("restored local attach runs hydrated live host startup command only when launch target matches", async () => {
  const bootHost = {
    id: "local-restored",
    label: "Project Shell",
    hostname: "localhost",
    username: "local",
    protocol: "local" as const,
    localShell: "/bin/zsh",
    localStartDir: "/tmp/project",
  };

  // Matching hydrated vault host runs its startup command.
  {
    const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
    const hostRef: { current: Partial<Host> } = { current: bootHost };
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const terminalBackend = createMockTerminalBackend({
      startLocalSession: async () => {
        await startGate;
        return "local-session";
      },
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sessionWrites.push({ id, data, automated: options?.automated });
      },
    });
    const ctx = createStarterContext({
      host: bootHost,
      hostRef,
      terminalSettings: { startupCommandDelayMs: 0 },
      terminalBackend,
      startupCommand: undefined,
      suppressHostStartupCommandRef: {
        current: shouldSuppressHostStartupCommandOnReconnect("restored"),
      },
      promptLineBreakStateRef: undefined,
    });

    const started = createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
    hostRef.current = { ...bootHost, startupCommand: "echo restored-local" };
    releaseStart?.();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(sessionWrites, [
      { id: "local-session", data: "echo restored-local\r", automated: true },
    ]);
  }

  // Mismatched shell/startDir/protocol keeps snapshot and skips the unrelated command.
  const mismatchCases: Array<[string, Partial<Host>]> = [
    ["localShell", { localShell: "/bin/bash" }],
    ["localStartDir", { localStartDir: "/tmp/other" }],
    ["localShellArgs", { localShellArgs: ["-l"] }],
    ["protocol", { protocol: "ssh" }],
  ];
  for (const [label, patch] of mismatchCases) {
    const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
    const hostRef: { current: Partial<Host> } = { current: bootHost };
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const terminalBackend = createMockTerminalBackend({
      startLocalSession: async () => {
        await startGate;
        return "local-session";
      },
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sessionWrites.push({ id, data, automated: options?.automated });
      },
    });
    const ctx = createStarterContext({
      host: bootHost,
      hostRef,
      terminalSettings: { startupCommandDelayMs: 0 },
      terminalBackend,
      startupCommand: undefined,
      suppressHostStartupCommandRef: {
        current: shouldSuppressHostStartupCommandOnReconnect("restored"),
      },
      promptLineBreakStateRef: undefined,
    });

    const started = createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
    hostRef.current = { ...bootHost, ...patch, startupCommand: "echo wrong-target" };
    releaseStart?.();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(sessionWrites, [], label);
  }
});

test("restored local attach through resolveTerminalSessionHost rejects hydrated startup command when saved host changed shell or dir", async () => {
  const restoredSession: TerminalSession = {
    id: "sess-restored-local",
    hostId: "local-restored-prod",
    hostLabel: "Project Shell",
    hostname: "localhost",
    username: "local",
    status: "connecting",
    protocol: "local",
    localShell: "/bin/zsh",
    localShellArgs: [],
    localStartDir: "/tmp/original-project",
  };
  const baseSavedHost: Host = createLocalShellHost({
    id: "local-restored-prod",
    label: "Project Shell",
    os: "macos",
    shell: "/bin/zsh",
    startDir: "/tmp/original-project",
    startupCommand: "echo hydrated-ok",
  });

  const runHydratedRestore = async (hydratedHost: Host) => {
    const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
    // Before vault hydration, resolveTerminalSessionHost builds the fallback host from the session.
    const preHydrationHost = resolveTerminalSessionHost({
      session: restoredSession,
      hosts: [],
      groupConfigs: [],
      proxyProfiles: [],
      localOs: "macos",
    });
    const hostRef: { current: Host } = { current: preHydrationHost };
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const terminalBackend = createMockTerminalBackend({
      startLocalSession: async () => {
        await startGate;
        return "local-session";
      },
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sessionWrites.push({ id, data, automated: options?.automated });
      },
    });
    const ctx = createStarterContext({
      host: preHydrationHost,
      hostRef,
      terminalSettings: { startupCommandDelayMs: 0 },
      terminalBackend,
      startupCommand: undefined,
      suppressHostStartupCommandRef: {
        current: shouldSuppressHostStartupCommandOnReconnect("restored"),
      },
      promptLineBreakStateRef: undefined,
    });

    const started = createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
    // Vault hydration resolves the saved host through production resolveTerminalSessionHost (with overlaySessionLocalShell).
    hostRef.current = resolveTerminalSessionHost({
      session: restoredSession,
      hosts: [hydratedHost],
      groupConfigs: [],
      proxyProfiles: [],
      localOs: "macos",
    });
    releaseStart?.();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return sessionWrites;
  };

  assert.deepEqual(await runHydratedRestore(baseSavedHost), [
    { id: "local-session", data: "echo hydrated-ok\r", automated: true },
  ]);

  const editedTargets: Array<[string, Host]> = [
    ["edited shell", { ...baseSavedHost, localShell: "/bin/bash", startupCommand: "echo wrong-shell" }],
    ["edited startDir", { ...baseSavedHost, localStartDir: "/tmp/edited-project", startupCommand: "echo wrong-dir" }],
    ["edited shellArgs", { ...baseSavedHost, localShellArgs: ["-l"], startupCommand: "echo wrong-args" }],
    ["edited protocol", { ...baseSavedHost, protocol: "ssh", hostname: "prod.example.test", username: "ops", startupCommand: "echo wrong-proto" }],
  ];
  for (const [label, editedHost] of editedTargets) {
    assert.deepEqual(
      await runHydratedRestore(editedHost),
      [],
      `${label}: startup command from an edited host must not run in the old session`,
    );
  }
});

test("real local PTY smoke: executes single-line and multi-line startup commands in configured startup directory", {
  timeout: 15000,
  skip: process.platform === "win32" ? "POSIX /bin/sh smoke test" : false,
}, async () => {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-local-startup-")));

  const runRealLocalPtyScenario = async (startupCommand: string | undefined, expectedMarker?: string) => {
    const host = createLocalShellHost({
      label: "Smoke Local",
      shell: "/bin/sh",
      startDir: tempDir,
      startupCommand,
    });

    let proc: pty.IPty | null = null;
    let output = "";
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(evt: { exitCode?: number }) => void>();
    const writes: string[] = [];

    const terminalBackend = createMockTerminalBackend({
      startLocalSession: async (options: { shell?: string; shellArgs?: string[]; cwd?: string; cols?: number; rows?: number }) => {
        proc = pty.spawn(options.shell || "/bin/sh", options.shellArgs ?? [], {
          name: "xterm-256color",
          cols: options.cols || 80,
          rows: options.rows || 24,
          cwd: options.cwd,
          env: {
            ...process.env,
            PS1: "__NC_PROMPT__$ ",
            TERM: "xterm-256color",
          },
        });
        proc.onData((chunk) => {
          output += chunk;
          for (const listener of dataListeners) listener(chunk);
        });
        proc.onExit((evt) => {
          for (const listener of exitListeners) listener(evt);
        });
        return "real-local-pty";
      },
      onSessionData: (_id: string, cb: (chunk: string) => void) => {
        dataListeners.add(cb);
        return () => dataListeners.delete(cb);
      },
      onSessionExit: (_id: string, cb: (evt: { exitCode?: number }) => void) => {
        exitListeners.add(cb);
        return () => exitListeners.delete(cb);
      },
      writeToSession: (_id: string, data: string) => {
        writes.push(data);
        proc?.write(data);
      },
    });

    const ctx = createStarterContext({
      host,
      terminalSettings: { startupCommandDelayMs: 120 },
      terminalBackend,
      startupCommand: undefined,
      promptLineBreakStateRef: undefined,
    });

    try {
      await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);

      if (expectedMarker) {
        const deadline = Date.now() + 8000;
        while (!output.includes(expectedMarker) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        assert.ok(
          output.includes(expectedMarker),
          `Expected PTY output to contain ${JSON.stringify(expectedMarker)}, got:\n${output}`,
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(writes, []);
      }
    } finally {
      try { proc?.kill(); } catch { /* ignore */ }
    }
  };

  try {
    await runRealLocalPtyScenario(
      'printf "__SINGLE_OK__:%s__\\n" "$(pwd -P)"',
      `__SINGLE_OK__:${tempDir}__`,
    );
    await runRealLocalPtyScenario(
      'TAG=netcatty4273\nprintf "__MULTI_OK__:%s:%s__\\n" "$TAG" "$(pwd -P)"',
      `__MULTI_OK__:netcatty4273:${tempDir}__`,
    );
    await runRealLocalPtyScenario("   \n  ");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
