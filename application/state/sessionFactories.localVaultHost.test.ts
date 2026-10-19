import assert from "node:assert/strict";
import test from "node:test";

import { createHostTerminalSession } from "./sessionFactories.ts";
import { createLocalTerminalSession } from "./sessionFactories.ts";
import { resolveHostDefaultLocalShell } from "../../domain/localShellHost";
import { resolveTerminalSessionHost } from "../../domain/terminalHostResolution";
import type { Host } from "../../domain/models";

const localVaultHost = (overrides: Partial<Host> = {}): Host => ({
  id: "local-vault-1",
  label: "Project A CMD",
  hostname: "localhost",
  username: "",
  group: "Projects/A",
  tags: ["local"],
  os: "linux",
  protocol: "local",
  createdAt: 0,
  ...overrides,
});

test("createHostTerminalSession copies local shell fields for local vault hosts", () => {
  const host = localVaultHost({
    localShell: "wsl-ubuntu",
    localShellArgs: ["--cd", "/work"],
    localShellName: "Ubuntu (WSL)",
    localShellIcon: "ubuntu",
    localStartDir: "/work",
  });
  const session = createHostTerminalSession("session-1", host);

  assert.equal(session.protocol, "local");
  assert.equal(session.hostId, "local-vault-1");
  assert.equal(session.localShell, "wsl-ubuntu");
  assert.deepEqual(session.localShellArgs, ["--cd", "/work"]);
  assert.equal(session.localShellName, "Ubuntu (WSL)");
  assert.equal(session.localShellIcon, "ubuntu");
  assert.equal(session.localStartDir, "/work");
});

test("createHostTerminalSession does not add local shell fields to SSH hosts", () => {
  const host: Host = {
    ...localVaultHost({ protocol: "ssh", hostname: "example.com", port: 22 }),
  } as Host;
  const session = createHostTerminalSession("session-2", host);

  assert.equal(session.protocol, "ssh");
  assert.equal(session.localShell, undefined);
  assert.equal(session.localShellName, undefined);
  assert.equal(session.shellType, undefined);
});

test("createHostTerminalSession classifies the shell for CMD/PowerShell local vault hosts", () => {
  const cmd = createHostTerminalSession("session-cmd", localVaultHost({ localShell: "cmd", os: "windows" }));
  assert.equal(cmd.shellType, "cmd");

  const pwsh = createHostTerminalSession("session-pwsh", localVaultHost({ localShell: "pwsh", os: "windows" }));
  assert.equal(pwsh.shellType, "powershell");

  // Discovered shell IDs persisted by the local-shell editor are not
  // executable basenames, but they still resolve to POSIX shells at spawn
  // time — WSL distros, Git Bash, and Cygwin all run a POSIX shell.
  const wslId = createHostTerminalSession("session-wsl-id", localVaultHost({ localShell: "wsl-ubuntu", os: "windows" }));
  assert.equal(wslId.shellType, "posix");

  const gitBash = createHostTerminalSession("session-git-bash", localVaultHost({ localShell: "git-bash", os: "windows" }));
  assert.equal(gitBash.shellType, "posix");

  const cygwin = createHostTerminalSession("session-cygwin", localVaultHost({ localShell: "cygwin", os: "windows" }));
  assert.equal(cygwin.shellType, "posix");

  // Unix discovery emits disambiguated path-slug IDs when multiple
  // installations share a basename (e.g. /bin/bash vs
  // /opt/homebrew/bin/bash); the backend launches the resolved command, so
  // the session must classify as that command's shell type, not "unknown".
  const slugBash = createHostTerminalSession("session-slug-bash", localVaultHost({ localShell: "bin-bash", os: "macos" }));
  assert.equal(slugBash.shellType, "posix");

  const slugHomebrewBash = createHostTerminalSession(
    "session-slug-homebrew",
    localVaultHost({ localShell: "opt-homebrew-bin-bash", os: "macos" }),
  );
  assert.equal(slugHomebrewBash.shellType, "posix");

  const customPowershellPath = createHostTerminalSession(
    "session-pwsh-path",
    localVaultHost({ localShell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", os: "windows" }),
  );
  assert.equal(customPowershellPath.shellType, "powershell");

  // Default-shell hosts (empty localShell) launch the machine's OS default
  // shell (the backend's own detection), so classification must use the
  // runtime platform — not the saved host.os, which may describe a machine
  // the host was synced/imported from. Node 22's navigator.userAgent is
  // always "Node.js/<version>", so this test environment always classifies
  // as POSIX regardless of the CI runner's real OS.
  const windowsSyncedDefault = createHostTerminalSession("session-win-default", localVaultHost({ os: "windows" }));
  assert.equal(windowsSyncedDefault.shellType, "posix");

  const posixDefault = createHostTerminalSession("session-posix-default", localVaultHost({ os: "linux" }));
  assert.equal(posixDefault.shellType, "posix");

  const unknownCustom = createHostTerminalSession(
    "session-unknown",
    localVaultHost({ localShell: "/usr/local/bin/exotic-shell", os: "linux" }),
  );
  assert.equal(unknownCustom.shellType, "unknown");
});

test("createLocalTerminalSession is unaffected by vault local hosts", () => {
  const session = createLocalTerminalSession("session-3", { shellName: "CMD" });
  assert.equal(session.hostId, "local-terminal");
  assert.equal(session.localShellName, "CMD");
});

test("createHostTerminalSession snapshots an explicit no-args local shell as an empty array", () => {
  // Legacy vault hosts can predate localShellArgs, so the field may be
  // absent on the Host; the session snapshot must still distinguish
  // "launched with no args" ([]) from "no metadata" (undefined).
  const host = localVaultHost({
    localShell: "cmd",
    localShellName: "Command Prompt",
    os: "windows",
  });
  const session = createHostTerminalSession("session-noargs", host);

  assert.ok(Array.isArray(session.localShellArgs), "args snapshot must be present");
  assert.deepEqual(session.localShellArgs, []);
});

test("resolveTerminalSessionHost does not merge edited host args into a no-args local snapshot", () => {
  const launchTimeHost = localVaultHost({
    localShell: "cmd",
    localShellName: "Command Prompt",
    os: "windows",
  });
  const session = createHostTerminalSession("session-1", launchTimeHost);

  // The saved host was later edited to a shell with args; the snapshot taken
  // at launch time must win so the clone relaunches CMD, not WSL.
  const editedHost: Host = {
    ...launchTimeHost,
    label: "Edited WSL",
    localShell: "wsl-ubuntu",
    localShellArgs: ["--cd", "/elsewhere"],
    localShellName: "Ubuntu (WSL)",
    localStartDir: "/elsewhere",
  };

  const resolved = resolveTerminalSessionHost({
    session,
    hosts: [editedHost],
    groupConfigs: [],
    proxyProfiles: [],
    localOs: "windows",
  });

  assert.equal(resolved.localShell, "cmd");
  assert.deepEqual(resolved.localShellArgs, []);
  assert.equal(resolved.localShellName, "Command Prompt");
});

test("createHostTerminalSession snapshots an inherited start directory for Copy Tab", () => {
  // The saved host has no directory of its own, so the starter launches in
  // Settings > Terminal's localStartDir. That effective directory has to be
  // recorded now; overlay falls back to the host or the current setting when
  // the session field is missing.
  const saved = localVaultHost({
    localShell: "bash",
    localShellName: "Bash",
    localStartDir: "",
  });
  const effective = resolveHostDefaultLocalShell(saved, {
    terminalSettings: { localStartDir: "/home/alice/global" },
  });
  const session = createHostTerminalSession("session-inherit", effective);
  assert.equal(session.localStartDir, "/home/alice/global");

  const changedSettings = {
    terminalSettings: { localShell: "fish", localStartDir: "/home/alice/changed" },
  };
  const afterSettingsChange = resolveTerminalSessionHost({
    session,
    hosts: [saved],
    groupConfigs: [],
    proxyProfiles: [],
    localOs: "linux",
    defaultLocalShell: changedSettings,
  });
  assert.equal(afterSettingsChange.localStartDir, "/home/alice/global");

  const afterHostEdit = resolveTerminalSessionHost({
    session,
    hosts: [{ ...saved, localStartDir: "/home/alice/edited" }],
    groupConfigs: [],
    proxyProfiles: [],
    localOs: "linux",
    defaultLocalShell: changedSettings,
  });
  assert.equal(afterHostEdit.localStartDir, "/home/alice/global");
});

test("createHostTerminalSession snapshots an inherited start directory for a default shell host", () => {
  const saved = localVaultHost();
  const effective = resolveHostDefaultLocalShell(saved, {
    terminalSettings: { localShell: "bash", localStartDir: "/home/alice/global" },
    resolveShellSetting: () => ({ command: "/bin/bash", args: ["-l"] }),
  });
  const session = createHostTerminalSession("session-default-shell", effective);

  assert.equal(session.localShell, "/bin/bash");
  assert.deepEqual(session.localShellArgs, ["-l"]);
  assert.equal(session.localStartDir, "/home/alice/global");
});

test("resolveHostDefaultLocalShell keeps an explicit start directory and ignores non-local hosts", () => {
  const explicit = localVaultHost({ localShell: "bash", localStartDir: "/work" });
  const resolvedExplicit = resolveHostDefaultLocalShell(explicit, {
    terminalSettings: { localStartDir: "/home/alice/global" },
  });
  assert.equal(resolvedExplicit.localStartDir, "/work");
  assert.equal(createHostTerminalSession("session-explicit", resolvedExplicit).localStartDir, "/work");

  const ssh = localVaultHost({ protocol: "ssh", hostname: "example.com", port: 22 });
  const resolvedSsh = resolveHostDefaultLocalShell(ssh, {
    terminalSettings: { localStartDir: "/home/alice/global" },
  });
  assert.equal(resolvedSsh.localStartDir, undefined);
  assert.equal(resolvedSsh, ssh);
});

test("saved local sessions use the ordinary local username marker without changing vault or SSH credentials", () => {
  const saved = localVaultHost({ username: "" });
  const ordinary = createLocalTerminalSession("ordinary-local");
  const opened = createHostTerminalSession("saved-local", saved);
  assert.equal(opened.username, ordinary.username);
  assert.equal(opened.username, "local");
  assert.equal(saved.username, "");
  const remote = { ...saved, protocol: "ssh" as const, username: "remote-user" };
  assert.equal(createHostTerminalSession("ssh-session", remote).username, "remote-user");
  const resolved = resolveTerminalSessionHost({ session: opened, hosts: [saved], groupConfigs: [], proxyProfiles: [], localOs: "linux" });
  assert.equal(resolved.username, ordinary.username, "terminal-run scripts receive the same local marker");
});
