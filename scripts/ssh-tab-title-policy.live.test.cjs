"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");

function launchFromNode() {
  const { spawnSync } = require("node:child_process");
  const { applyElectronLaunchEnv } = require("../electron/launchEnv.cjs");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const prefix = `${temp.getTempFilePath("ssh-tab-title-policy")}-`;
  const userData = fs.mkdtempSync(prefix);
  let code = 1;
  try {
    const result = spawnSync(require("electron"), [__filename], {
      cwd: root, stdio: "inherit", timeout: 65_000,
      env: { ...applyElectronLaunchEnv(process.env), NETCATTY_SSH_TITLE_USER_DATA: userData },
    });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  } finally {
    // Chromium owns profile files until the child exits, especially on Windows.
    const target = path.resolve(userData);
    console.log("SSH_TAB_TITLE_CLEANUP", target);
    assert.equal(path.dirname(target), path.dirname(path.resolve(prefix)));
    assert.ok(path.basename(target).startsWith(path.basename(prefix)));
    const stat = fs.lstatSync(target);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  process.exit(code);
}

function fixtureResponse(request) {
  const url = new URL(request.url);
  if (url.hostname !== "fixture") return new Response("Not found", { status: 404 });
  if (url.pathname === "/index.html") return new Response("<body><div id='root'></div>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    return new Response("Invalid resource path", { status: 400 });
  }
  const publicRoot = path.join(root, "public");
  const file = path.resolve(publicRoot, `.${pathname}`);
  const relative = path.relative(publicRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Not found", { status: 404 });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("Not found", { status: 404 });
  const mime = {
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2",
  }[path.extname(file)] ?? "application/octet-stream";
  return new Response(fs.readFileSync(file), { headers: { "Content-Type": mime } });
}

function runInElectron() {
  const { app, BrowserWindow, protocol } = require("electron");
  assert.ok(process.env.NETCATTY_SSH_TITLE_USER_DATA,
    "Launch with node scripts/ssh-tab-title-policy.live.test.cjs so profile cleanup runs after Electron exits.");
  protocol.registerSchemesAsPrivileged([{
    scheme: "ssh-title-test", privileges: { standard: true, secure: true, supportFetchAPI: true },
  }]);
  app.setPath("userData", process.env.NETCATTY_SSH_TITLE_USER_DATA);
  app.on("window-all-closed", () => {});
  let win;
  let finished = false;
  const finish = code => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    win?.destroy();
    app.exit(code);
  };
  const watchdog = setTimeout(() => {
    console.error("SSH_TAB_TITLE_FAILED: real component verification exceeded 60 seconds");
    finish(1);
  }, 60_000);

  void app.whenReady().then(async () => {
    const bundle = esbuild.buildSync({
      entryPoints: [path.join(__dirname, "fixtures/ssh-tab-title-policy.tsx")],
      bundle: true, format: "cjs", platform: "browser", write: false,
      alias: {
        "node:diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
        "diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
      },
      define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}",
        "process.env.NODE_ENV": '"production"',
      },
    }).outputFiles[0].text;
    win = new BrowserWindow({
      show: process.env.NETCATTY_SSH_TITLE_SHOW_WINDOW === "1", width: 1280, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const consoleErrors = [];
    win.webContents.on("console-message", details => {
      if (details.level === "error") consoleErrors.push(details.message);
    });
    protocol.handle("ssh-title-test", fixtureResponse);
    await win.loadURL("ssh-title-test://fixture/index.html");
    const { rows, promptOnlyParentRenders } = await win.webContents.executeJavaScript(`(async () => {
      const loaded = { exports: {} };
      ((module, exports) => { ${bundle} })(loaded, loaded.exports);
      return loaded.exports.runSshTabTitlePolicy();
    })()`);
    assert.ok(rows.length > 0, "The real component fixture must produce assertions");
    for (const row of rows) {
      assert.equal(row.actual, row.expected, `${row.scenario}; production tab=${row.tabId}`);
    }
    console.log("SSH_TAB_TITLE_BROWSER_CONSOLE_ERRORS", JSON.stringify(consoleErrors));
    assert.equal(consoleErrors.length, 0, "The real production components must not log browser errors");
    assert.equal(promptOnlyParentRenders, 0, "Prompt-only store updates must not force the fixture parent to render");
    console.log("SSH_TAB_TITLE_POLICY_OK", JSON.stringify({ assertions: rows.length, consoleErrors: consoleErrors.length, promptOnlyParentRenders }));
    finish(0);
  }).catch(error => {
    console.error("SSH_TAB_TITLE_POLICY_FAILED", error);
    finish(1);
  });
}

if (process.versions.electron) runInElectron();
else launchFromNode();
