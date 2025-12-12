const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const electronPath = require("electron"); // returns binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const isMac = process.platform === "darwin";

// On macOS, WebAuthn/FIDO (Touch ID / platform authenticators) is much more reliable
// when the app is launched via Finder (LaunchServices). `open -a` doesn't pass env vars,
// so for dev mode we persist the dev server URL to a temp file that main.cjs can read.
if (isMac) {
  const configPath = path.join(__dirname, ".dev-config.json");
  const hasDevServerUrl = !!env.VITE_DEV_SERVER_URL;
  if (hasDevServerUrl) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        VITE_DEV_SERVER_URL: env.VITE_DEV_SERVER_URL,
      }),
    );
  }

  // Find the Electron.app bundle path from the electron binary
  // electronPath is like: /path/to/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
  const electronAppPath = path.resolve(electronPath, "../../.."); // -> Electron.app
  const appDir = path.resolve(__dirname, "..");

  console.log("[Launch] Starting Electron via LaunchServices (macOS WebAuthn support)...");

  const child = spawn(
    "open",
    ["-a", electronAppPath, "-W", "--args", appDir],
    { stdio: "inherit" },
  );

  child.on("exit", (code) => {
    if (hasDevServerUrl) {
      try {
        fs.unlinkSync(configPath);
      } catch {}
    }
    process.exit(code ?? 0);
  });
} else {
  // Non-macOS: use direct spawn
  const child = spawn(electronPath, ["."], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
}
