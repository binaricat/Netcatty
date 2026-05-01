// Compute the platform-specific `extraResources` entry for bundling
// mosh-client. Lives under scripts/ (eslint-ignored) so it can use
// Node CommonJS globals freely; consumed from electron-builder.config.cjs.
//
// Binaries are produced by .github/workflows/build-mosh-binaries.yml and
// downloaded into resources/mosh/<platform-arch>/ by
// scripts/fetch-mosh-binaries.cjs (gated on MOSH_BIN_RELEASE).
//
// We only emit the directive when the binary is actually on disk so that
// `npm run pack` keeps working without bundled mosh — for example, when
// the developer skipped the fetch step or the relevant arch hasn't been
// built yet.
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
    return [{ from: `resources/mosh/linux-${arch}/`, to: "mosh/", filter: ["mosh-client"] }];
  }

  if (platform === "win32") {
    // Windows ships mosh-client.exe + Cygwin DLL bundle (cygwin1.dll,
    // cygcrypto-*.dll, etc.) plus the ncurses terminfo entry used by
    // TERM=xterm-256color.
    const arch = requestedArch();
    const exe = path.join(moshRoot, `win32-${arch}`, "mosh-client.exe");
    const dllDir = path.join(moshRoot, `win32-${arch}`, `mosh-client-win32-${arch}-dlls`);
    if (!hasFile(exe) || !hasDir(dllDir)) return [];
    const resources = [
      { from: `resources/mosh/win32-${arch}/`, to: "mosh/", filter: ["mosh-client.exe"] },
      {
        from: `resources/mosh/win32-${arch}/mosh-client-win32-${arch}-dlls/`,
        to: `mosh/mosh-client-win32-${arch}-dlls/`,
        filter: ["**/*"],
      },
    ];
    const terminfoDir = path.join(moshRoot, `win32-${arch}`, "terminfo");
    if (hasDir(terminfoDir)) {
      resources.push({ from: `resources/mosh/win32-${arch}/terminfo/`, to: "mosh/terminfo/", filter: ["**/*"] });
    }
    return resources;
  }

  return [];
}

module.exports = { moshExtraResources };
