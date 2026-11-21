import assert from "node:assert/strict";
import test from "node:test";
import {
  getWslDistributionName,
  isWslLocalShell,
  resolveWslLinuxCwdForLocalWindowsSftp as mapCwd,
  resolveWslLocalSftpInitialPath,
} from "./sftpWslLocalPath";
import { isSftpFollowTargetPath } from "./sftpFollowTerminalCwd";

const wsl = {
  id: "wsl-ubuntu-22-04",
  protocol: "local",
  localShell: "wsl.exe",
  localShellArgs: ["-d", "Ubuntu-22.04"],
  localShellName: "Ubuntu-22.04 (WSL)",
};
const root = "\\\\wsl.localhost\\Ubuntu-22.04";

test("WSL distro uses the real argument, then display name, never a slug", () => {
  assert.equal(getWslDistributionName({ ...wsl, localShellName: "Debian (WSL)" }), "Ubuntu-22.04");
  assert.equal(getWslDistributionName({ ...wsl, localShellArgs: undefined }), "Ubuntu-22.04");
  assert.equal(getWslDistributionName({ ...wsl, localShellArgs: ["-d"] }), "Ubuntu-22.04");
  assert.equal(getWslDistributionName({ id: wsl.id }), null);
  assert.equal(getWslDistributionName({ localShellName: "Ubuntu" }), null);
  assert.equal(getWslDistributionName({ localShellArgs: ["-d", "bad/name"] }), null);
});

test("only local WSL launch metadata enables WSL detection", () => {
  for (const launch of [
    { id: wsl.id },
    { localShell: wsl.id },
    { localShell: "wsl" },
    { localShell: "C:\\Windows\\System32\\WSL.EXE" },
    { localShellArgs: ["-d", "Ubuntu-22.04"] },
  ]) {
    assert.equal(isWslLocalShell({ protocol: "local", ...launch }), true);
  }
  for (const localShell of ["cmd.exe", "powershell.exe", "pwsh", "bash.exe", "git-bash", "cygwin"]) {
    assert.equal(isWslLocalShell({ protocol: "local", localShell }), false);
  }
  assert.equal(isWslLocalShell({ ...wsl, protocol: "ssh" }), false);
  assert.equal(isWslLocalShell(null), false);
});

test("WSL default drive mounts map to Windows drives, including the mount root", () => {
  assert.equal(mapCwd("/mnt/c/Users/trum", "Ubuntu-22.04"), "C:\\Users\\trum");
  assert.equal(mapCwd("/mnt/C/Users/trum"), "C:\\Users\\trum");
  assert.equal(mapCwd("/mnt/d/data/project"), "D:\\data\\project");
  assert.equal(mapCwd("/mnt/c"), "C:\\");
  assert.equal(mapCwd("/mnt/c/"), "C:\\");
  assert.equal(mapCwd("/mnt/cat", "Ubuntu-22.04"), `${root}\\mnt\\cat`);
});

test("Linux absolute paths map to the named distro share", () => {
  assert.equal(mapCwd("/home/vastbase", "Ubuntu-22.04"), `${root}\\home\\vastbase`);
  assert.equal(mapCwd("/etc", "Ubuntu-22.04"), `${root}\\etc`);
  assert.equal(mapCwd("/", "Ubuntu-22.04"), root);
  assert.equal(mapCwd("/home/vastbase/dir ", "Ubuntu-22.04"), `${root}\\home\\vastbase\\dir `);
  for (const cwd of ["", "   ", "~", "~/src", "relative", "/home/vastbase"]) {
    assert.equal(mapCwd(cwd), null);
  }
  assert.equal(mapCwd("~", "Ubuntu-22.04"), null);
});

test("Windows drive and UNC paths pass through with Windows separators", () => {
  for (const [cwd, expected] of [
    ["C:\\Users\\trum", "C:\\Users\\trum"],
    ["C:/Users/trum", "C:\\Users\\trum"],
    [`${root}\\home\\vastbase`, `${root}\\home\\vastbase`],
    ["\\\\wsl$\\Ubuntu-22.04\\etc", "\\\\wsl$\\Ubuntu-22.04\\etc"],
    ["//wsl.localhost/Ubuntu-22.04/home", `${root}\\home`],
  ]) assert.equal(mapCwd(cwd), expected);
});

test("follow targets accept UNC shares as well as existing POSIX and drive paths", () => {
  for (const path of [root, `${root}\\home\\vastbase`, "\\\\server\\share\\dir", "/home/user", "C:\\Users"]) {
    assert.equal(isSftpFollowTargetPath(path), true);
  }
  for (const path of ["~", "relative", "\\relative", "\\\\server"]) {
    assert.equal(isSftpFollowTargetPath(path), false);
  }
});

test("Windows WSL initial landing uses the cwd or the real distro share root", () => {
  assert.equal(resolveWslLocalSftpInitialPath(wsl, "/home/vastbase", true), `${root}\\home\\vastbase`);
  assert.equal(resolveWslLocalSftpInitialPath(wsl, "/mnt/c/Users/trum", true), "C:\\Users\\trum");
  for (const cwd of [null, "", "~", "~/src"]) {
    assert.equal(resolveWslLocalSftpInitialPath(wsl, cwd, true), root);
  }
  assert.equal(resolveWslLocalSftpInitialPath({ ...wsl, localShellArgs: [], localShellName: undefined }, null, true), undefined);
  assert.equal(resolveWslLocalSftpInitialPath(wsl, "/home/vastbase", false), undefined);
  assert.equal(resolveWslLocalSftpInitialPath({ protocol: "local", localShell: "powershell.exe" }, null, true), undefined);
  assert.equal(resolveWslLocalSftpInitialPath({ ...wsl, protocol: "ssh" }, "/home/vastbase", true), undefined);
});
