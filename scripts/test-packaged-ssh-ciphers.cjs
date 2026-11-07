// Exercise shipped JS/dependencies with the same Electron runtime, headlessly.
// No BrowserWindow, real accounts, or external SSH hosts are involved.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const releaseDir = path.resolve(process.argv[2] || "release");
const archives = fs.readdirSync(releaseDir, { recursive: true })
  .filter((entry) => path.basename(entry) === "app.asar")
  .map((entry) => path.join(releaseDir, entry));
if (archives.length === 0) throw new Error("No packaged app.asar found");
for (const appRoot of archives) {
  // Outside the checkout, a missing packaged dependency cannot resolve from
  // the checkout's node_modules. Copy the paired unpacked payload as shipped.
  const detachedDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-packaged-ssh-"));
  try {
    const detachedRoot = path.join(detachedDir, "app.asar");
    fs.copyFileSync(appRoot, detachedRoot);
    fs.cpSync(`${appRoot}.unpacked`, `${detachedRoot}.unpacked`, { recursive: true });
    const env = {
      ...process.env,
      NETCATTY_SSH_TEST_APP_ROOT: detachedRoot,
      NETCATTY_SSH_TEST_RUNTIME: require("electron"),
    };
    delete env.NODE_PATH;
    console.log(`Testing detached packaged SSH transport: ${appRoot}`);
    const result = spawnSync(process.execPath, ["--test", "electron/bridges/sshChaChaTransport.test.cjs"], {
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Packaged SSH transport tests failed (${result.status})`);
  } finally {
    fs.rmSync(detachedDir, { recursive: true, force: true });
  }
}
