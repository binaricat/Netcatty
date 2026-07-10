// Platform-specific electron-builder extraResources for the MoshCatty client.
// Binaries are downloaded from binaricat/MoshCatty into resources/mosh/ by
// scripts/fetch-mosh-binaries.cjs. Pure single-binary layout only.

const fs = require("node:fs");
const path = require("node:path");

function requestedArch() {
  return process.env.npm_config_arch || process.env.npm_config_target_arch || process.arch;
}

function hasFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function moshExtraResources(platform) {
  const moshRoot = path.resolve(process.cwd(), "resources", "mosh");
  if (!fs.existsSync(moshRoot)) return [];

  if (platform === "darwin") {
    const file = path.join(moshRoot, "darwin-universal", "mosh-client");
    if (!hasFile(file)) return [];
    return [
      { from: "resources/mosh/darwin-universal/", to: "mosh/", filter: ["mosh-client"] },
    ];
  }

  if (platform === "linux") {
    const arch = requestedArch();
    const file = path.join(moshRoot, `linux-${arch}`, "mosh-client");
    if (!hasFile(file)) return [];
    return [
      { from: `resources/mosh/linux-${arch}/`, to: "mosh/", filter: ["mosh-client"] },
    ];
  }

  if (platform === "win32") {
    const arch = requestedArch();
    const exe = path.join(moshRoot, `win32-${arch}`, "mosh-client.exe");
    if (!hasFile(exe)) return [];
    return [
      { from: `resources/mosh/win32-${arch}/`, to: "mosh/", filter: ["mosh-client.exe"] },
    ];
  }

  return [];
}

module.exports = { moshExtraResources };
