const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function findCompiler(env = process.env) {
  if (env.CXX) return env.CXX;
  if (env.CL) return "cl.exe";
  return "cl.exe";
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function makeCmdScriptPath(tmpdir, targetArch) {
  return path.win32.join(tmpdir(), `build-netcatty-windows-hello-${targetArch}.cmd`);
}

function visualStudioDevCmdCandidates(env = process.env) {
  const candidates = [];
  if (env.VSINSTALLDIR) {
    candidates.push(path.win32.join(env.VSINSTALLDIR, "Common7", "Tools", "VsDevCmd.bat"));
  }

  const programFilesRoots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  const versions = ["2026", "2022", "2019"];
  const editions = ["Enterprise", "Professional", "Community", "BuildTools", "Preview"];
  for (const root of programFilesRoots) {
    for (const version of versions) {
      for (const edition of editions) {
        candidates.push(
          path.win32.join(root, "Microsoft Visual Studio", version, edition, "Common7", "Tools", "VsDevCmd.bat"),
        );
      }
    }
  }

  return [...new Set(candidates)];
}

function findVisualStudioDevCmd(env = process.env, existsSync = fs.existsSync) {
  return visualStudioDevCmdCandidates(env).find((candidate) => existsSync(candidate)) || null;
}

function hasInitializedMsvcEnvironment(env = process.env, targetArch) {
  const initializedArch = String(env.VSCMD_ARG_TGT_ARCH || "").toLowerCase();
  if (initializedArch) return initializedArch === targetArch;
  return Boolean(env.VSCMD_VER && env.INCLUDE && env.LIB);
}

function normalizeWindowsHelperArch(arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  if (arch === 1 || arch === "1") return "x64";
  if (arch === 3 || arch === "3") return "arm64";
  return null;
}

function getExpectedPeMachine(arch) {
  if (arch === "x64") return 0x8664;
  if (arch === "arm64") return 0xaa64;
  return null;
}

function readPeMachine(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
  return buffer.readUInt16LE(peOffset + 4);
}

function buildWindowsHelloHelper({
  projectDir = process.cwd(),
  platform = process.platform,
  arch = process.env.npm_config_arch || process.arch,
  env = process.env,
  run = execFileSync,
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  rm = fs.rmSync,
  tmpdir = require("node:os").tmpdir,
  existsSync = fs.existsSync,
  readMachine = readPeMachine,
  logger = console,
} = {}) {
  if (platform !== "win32") return { skipped: true, reason: "non-windows" };
  const targetArch = normalizeWindowsHelperArch(arch);
  if (!targetArch) return { skipped: true, reason: "unsupported-arch" };

  const pathApi = platform === "win32" ? path.win32 : path;
  const sourcePath = pathApi.join(projectDir, "electron", "bridges", "windowsHelloHelper", "NetcattyWindowsHello.cpp");
  const outputDir = pathApi.join(projectDir, "electron", "bridges", "windowsHelloHelper", "build", targetArch);
  const outputPath = pathApi.join(outputDir, "NetcattyWindowsHello.exe");
  mkdir(outputDir, { recursive: true });

  const compiler = findCompiler(env);
  const machine = targetArch === "arm64" ? "ARM64" : "X64";
  const compilerArgs = [
    "/nologo",
    "/EHsc",
    "/std:c++17",
    "/D_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS",
    sourcePath,
    "/Fe:" + outputPath,
    "/link",
    "/MACHINE:" + machine,
    "runtimeobject.lib",
    "windowsapp.lib",
  ];
  try {
    const shouldInitializeMsvc = compiler === "cl.exe" && !hasInitializedMsvcEnvironment(env, targetArch);
    const vsDevCmd = shouldInitializeMsvc ? findVisualStudioDevCmd(env, existsSync) : null;
    if (vsDevCmd) {
      const devArch = targetArch === "arm64" ? "arm64" : "x64";
      const compileCommand = [
        "call",
        quoteCmdArg(vsDevCmd),
        `-arch=${devArch}`,
        "-host_arch=x64",
        "&&",
        quoteCmdArg(compiler),
        ...compilerArgs.map(quoteCmdArg),
      ].join(" ");
      const scriptPath = makeCmdScriptPath(tmpdir, targetArch);
      writeFile(scriptPath, `@echo off\r\n${compileCommand}\r\n`, "utf8");
      try {
        run("cmd.exe", ["/d", "/c", scriptPath], {
          cwd: projectDir,
          stdio: "inherit",
          env,
        });
      } finally {
        rm(scriptPath, { force: true });
      }
    } else {
      run(compiler, compilerArgs, {
        cwd: projectDir,
        stdio: "inherit",
        env,
      });
    }
  } catch (err) {
    logger.warn?.(`[windowsHelloHelper] Failed to build Windows Hello helper: ${err?.message || err}`);
    return { skipped: true, reason: "compiler-unavailable" };
  }

  const expectedMachine = getExpectedPeMachine(targetArch);
  const actualMachine = readMachine(outputPath);
  if (actualMachine !== expectedMachine) {
    logger.warn?.(`[windowsHelloHelper] Built helper machine ${actualMachine} does not match ${targetArch}`);
    return { skipped: true, reason: "wrong-arch" };
  }

  return { skipped: false, outputPath };
}

if (require.main === module) {
  const result = buildWindowsHelloHelper();
  if (result.skipped) {
    console.log(`[windowsHelloHelper] skipped: ${result.reason}`);
  } else {
    console.log(`[windowsHelloHelper] built: ${result.outputPath}`);
  }
}

module.exports = {
  buildWindowsHelloHelper,
  findCompiler,
  findVisualStudioDevCmd,
  getExpectedPeMachine,
  hasInitializedMsvcEnvironment,
  makeCmdScriptPath,
  normalizeWindowsHelperArch,
  readPeMachine,
  visualStudioDevCmdCandidates,
};
