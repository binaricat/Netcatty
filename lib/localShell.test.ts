import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

import { classifyLocalShellType, detectLocalOs } from "./localShell";

const require = createRequire(import.meta.url);
const cjsLocalShell = require("./localShell.cjs") as {
  classifyLocalShellType: typeof classifyLocalShellType;
  detectLocalOs: typeof detectLocalOs;
};

test("local shell classification is shared between renderer and CommonJS bridge", () => {
  const cases: Array<[string | undefined, string | undefined, ReturnType<typeof classifyLocalShellType>]> = [
    ["/bin/zsh", "MacIntel", "posix"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "Win32", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "Win32", "cmd"],
    ["C:\\Windows\\System32\\wsl.exe", "Win32", "posix"],
    ["C:\\msys64\\usr\\bin\\bash.exe", "Win32", "posix"],
    ["fish", "linux", "fish"],
    ["", "Win32", "powershell"],
    [undefined, "MacIntel", "posix"],
    ["custom-shell", "linux", "unknown"],
  ];

  for (const [shellPath, platform, expected] of cases) {
    assert.equal(classifyLocalShellType(shellPath, platform), expected);
    assert.equal(cjsLocalShell.classifyLocalShellType(shellPath, platform), expected);
  }
});

test("local OS detection is shared between renderer and CommonJS bridge", () => {
  assert.equal(detectLocalOs("MacIntel"), "macos");
  assert.equal(cjsLocalShell.detectLocalOs("MacIntel"), "macos");
  assert.equal(detectLocalOs("Win32"), "windows");
  assert.equal(cjsLocalShell.detectLocalOs("Win32"), "windows");
});
