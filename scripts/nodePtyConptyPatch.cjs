const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ELECTRON_BUILDER_ARCH = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

function nodePtyArtifacts(projectDir) {
  const releaseDir = path.join(projectDir, "node_modules", "node-pty", "build", "Release");
  return [
    { source: path.join(releaseDir, "conpty.node"), relative: "conpty.node" },
    { source: path.join(releaseDir, "conpty", "conpty.dll"), relative: path.join("conpty", "conpty.dll") },
    { source: path.join(releaseDir, "conpty", "OpenConsole.exe"), relative: path.join("conpty", "OpenConsole.exe") },
  ];
}

function rebuildPatchedNodePty({
  projectDir,
  platform,
  arch,
  run = execFileSync,
  exists = fs.existsSync,
  logger = console,
}) {
  if (platform !== "win32") return false;
  const targetArch = typeof arch === "number" ? ELECTRON_BUILDER_ARCH[arch] : arch;
  if (!targetArch || targetArch === "universal") {
    throw new Error(`[nodePtyConptyPatch] Unsupported Windows architecture: ${String(arch)}`);
  }

  const rebuildCli = path.join(projectDir, "node_modules", "@electron", "rebuild", "lib", "cli.js");
  logger.log(`[nodePtyConptyPatch] Rebuilding patched node-pty for Windows ${targetArch}`);
  run(process.execPath, [
    rebuildCli,
    "--force",
    "--build-from-source",
    "--only",
    "node-pty",
    "--arch",
    targetArch,
  ], {
    cwd: projectDir,
    stdio: "inherit",
  });

  const nodePtyDir = path.join(projectDir, "node_modules", "node-pty");
  run(process.execPath, [path.join(nodePtyDir, "scripts", "post-install.js")], {
    cwd: projectDir,
    stdio: "inherit",
    env: { ...process.env, npm_config_arch: targetArch },
  });

  const missingArtifacts = nodePtyArtifacts(projectDir)
    .map(({ source }) => source)
    .filter((filePath) => !exists(filePath));
  if (missingArtifacts.length > 0) {
    throw new Error(
      `[nodePtyConptyPatch] Patched node-pty artifacts missing: ${missingArtifacts.join(", ")}`,
    );
  }
  return true;
}

function copyPatchedNodePtyToPackagedApp({ projectDir, resourcesDir, copy = fs.copyFileSync, mkdir = fs.mkdirSync }) {
  const packagedReleaseDir = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  const copied = [];
  for (const artifact of nodePtyArtifacts(projectDir)) {
    const destination = path.join(packagedReleaseDir, artifact.relative);
    mkdir(path.dirname(destination), { recursive: true });
    copy(artifact.source, destination);
    copied.push(destination);
  }
  return copied;
}

module.exports = {
  copyPatchedNodePtyToPackagedApp,
  nodePtyArtifacts,
  rebuildPatchedNodePty,
};
