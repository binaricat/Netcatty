// Compute the platform-specific `extraResources` entry for bundling the
// EternalTerminal `et` client. Lives under scripts/ (eslint-ignored) so it
// can use Node CommonJS globals freely; consumed from
// electron-builder.config.cjs.
//
// Binaries are produced by .github/workflows/build-et-binaries.yml and
// downloaded into resources/et/<platform-arch>/ by
// scripts/fetch-et-binaries.cjs (gated on ET_BIN_RELEASE).
//
// We only emit the directive when the binary is actually on disk so that
// `npm run pack` keeps working without a bundled et — for example, when the
// developer skipped the fetch step or the relevant arch hasn't been built
// yet.
//
// Unlike mosh-client, `et` is a pure network-transport client and does not
// render a terminal locally, so there is no terminfo bundle to package.
const fs = require("node:fs");
const path = require("node:path");

function requestedArch() {
  return process.env.npm_config_arch || process.env.npm_config_target_arch || process.arch;
}

function hasFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function hasDir(dir) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

function etExtraResources(platform) {
  const etRoot = path.resolve(process.cwd(), "resources", "et");
  if (!fs.existsSync(etRoot)) return [];

  if (platform === "darwin") {
    const file = path.join(etRoot, "darwin-universal", "et");
    if (!hasFile(file)) return [];
    return [
      { from: "resources/et/darwin-universal/", to: "et/", filter: ["et"] },
    ];
  }

  if (platform === "linux") {
    const arch = requestedArch();
    const file = path.join(etRoot, `linux-${arch}`, "et");
    if (!hasFile(file)) return [];
    return [
      { from: `resources/et/linux-${arch}/`, to: "et/", filter: ["et"] },
    ];
  }

  if (platform === "win32") {
    const arch = requestedArch();
    const exe = path.join(etRoot, `win32-${arch}`, "et.exe");
    const dllDir = path.join(etRoot, `win32-${arch}`, `et-win32-${arch}-dlls`);
    if (!hasFile(exe)) return [];
    const resources = [
      { from: `resources/et/win32-${arch}/`, to: "et/", filter: ["et.exe"] },
    ];
    // Static MSVC builds ship no DLLs; only package the directory when a
    // dynamically-linked build produced one.
    if (hasDir(dllDir)) {
      resources.push({
        from: `resources/et/win32-${arch}/et-win32-${arch}-dlls/`,
        to: `et/et-win32-${arch}-dlls/`,
        filter: ["**/*"],
      });
    }
    return resources;
  }

  return [];
}

module.exports = { etExtraResources };
