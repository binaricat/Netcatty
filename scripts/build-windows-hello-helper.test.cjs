const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildWindowsHelloHelper,
  getExpectedPeMachine,
  normalizeWindowsHelperArch,
  readPeMachine,
} = require("./build-windows-hello-helper.cjs");

test("normalizeWindowsHelperArch accepts only packaged Windows architectures", () => {
  assert.equal(normalizeWindowsHelperArch("x64"), "x64");
  assert.equal(normalizeWindowsHelperArch("arm64"), "arm64");
  assert.equal(normalizeWindowsHelperArch(1), "x64");
  assert.equal(normalizeWindowsHelperArch(3), "arm64");
  assert.equal(normalizeWindowsHelperArch("ia32"), null);
  assert.equal(normalizeWindowsHelperArch(""), null);
});

test("getExpectedPeMachine maps target helper architectures", () => {
  assert.equal(getExpectedPeMachine("x64"), 0x8664);
  assert.equal(getExpectedPeMachine("arm64"), 0xaa64);
  assert.equal(getExpectedPeMachine("ia32"), null);
});

test("buildWindowsHelloHelper writes target architecture helper into an arch-specific directory", () => {
  const calls = [];
  const result = buildWindowsHelloHelper({
    projectDir: "/repo",
    platform: "win32",
    arch: "arm64",
    env: {},
    run: (...args) => calls.push(args),
    mkdir: () => {},
    readMachine: () => 0xaa64,
    logger: { warn() {} },
  });

  assert.equal(result.skipped, false);
  assert.equal(
    result.outputPath,
    path.win32.join("\\repo", "electron", "bridges", "windowsHelloHelper", "build", "arm64", "NetcattyWindowsHello.exe"),
  );
  assert.match(
    calls[0][1].join(" "),
    /\/Fe:.*windowsHelloHelper.*build.*arm64.*NetcattyWindowsHello\.exe/,
  );
  assert.ok(
    calls[0][1].includes("/D_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS"),
    "Windows Hello helper compile must tolerate older C++/WinRT headers on newer MSVC",
  );
  assert.deepEqual(calls[0][1].slice(-4), ["/link", "/MACHINE:ARM64", "runtimeobject.lib", "windowsapp.lib"]);
});

test("buildWindowsHelloHelper initializes the Visual Studio developer environment when cl is not already on PATH", () => {
  const calls = [];
  const writes = [];
  const removals = [];
  const vsDevCmd = "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise\\Common7\\Tools\\VsDevCmd.bat";
  const result = buildWindowsHelloHelper({
    projectDir: "D:\\a\\Netcatty\\Netcatty",
    platform: "win32",
    arch: "x64",
    env: {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    },
    existsSync: (candidate) => candidate === vsDevCmd,
    run: (...args) => calls.push(args),
    writeFile: (...args) => writes.push(args),
    rm: (...args) => removals.push(args),
    tmpdir: () => "D:\\a\\_temp",
    mkdir: () => {},
    readMachine: () => 0x8664,
    logger: { warn() {} },
  });

  assert.equal(result.skipped, false);
  assert.equal(calls[0][0], "cmd.exe");
  assert.deepEqual(calls[0][1].slice(0, 3), ["/d", "/c", writes[0][0]]);
  assert.match(writes[0][0], /build-netcatty-windows-hello-x64\.cmd$/);
  assert.match(writes[0][1], /call "C:\\Program Files\\Microsoft Visual Studio\\2026\\Enterprise\\Common7\\Tools\\VsDevCmd\.bat"/);
  assert.match(writes[0][1], /-arch=x64/);
  assert.match(writes[0][1], /cl\.exe/);
  assert.match(writes[0][1], /\/MACHINE:X64/);
  assert.deepEqual(removals[0], [writes[0][0], { force: true }]);
});

test("buildWindowsHelloHelper uses the current MSVC environment when it is already initialized", () => {
  const calls = [];
  const vsDevCmd = "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\Tools\\VsDevCmd.bat";
  const result = buildWindowsHelloHelper({
    projectDir: "D:\\a\\Netcatty\\Netcatty",
    platform: "win32",
    arch: "x64",
    env: {
      VSINSTALLDIR: "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\",
      VSCMD_ARG_TGT_ARCH: "x64",
      VSCMD_VER: "18.0.0",
    },
    existsSync: (candidate) => candidate === vsDevCmd,
    run: (...args) => calls.push(args),
    mkdir: () => {},
    readMachine: () => 0x8664,
    logger: { warn() {} },
  });

  assert.equal(result.skipped, false);
  assert.equal(calls[0][0], "cl.exe");
  assert.match(calls[0][1].join(" "), /\/MACHINE:X64/);
});

test("buildWindowsHelloHelper rejects unsupported target architectures on Windows", () => {
  const result = buildWindowsHelloHelper({
    projectDir: "/repo",
    platform: "win32",
    arch: "ia32",
    mkdir: () => {
      throw new Error("should not create output dir");
    },
    run: () => {
      throw new Error("should not run compiler");
    },
    logger: { warn() {} },
  });

  assert.deepEqual(result, { skipped: true, reason: "unsupported-arch" });
});

test("buildWindowsHelloHelper rejects a built helper with the wrong PE machine", () => {
  const result = buildWindowsHelloHelper({
    projectDir: "/repo",
    platform: "win32",
    arch: "arm64",
    mkdir: () => {},
    run: () => {},
    readMachine: () => 0x8664,
    logger: { warn() {} },
  });

  assert.deepEqual(result, { skipped: true, reason: "wrong-arch" });
});

test("readPeMachine reads the PE COFF machine value", () => {
  const buffer = Buffer.alloc(0x90);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "ascii");
  buffer.writeUInt16LE(0xaa64, 0x84);

  assert.equal(readPeMachine(buffer), 0xaa64);
  assert.equal(readPeMachine(Buffer.from("not-pe")), null);
});
