"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LIVE_ENV = "NETCATTY_XTERM_SYNC_RENDER_LIVE";
const USER_DATA_ENV = "NETCATTY_XTERM_SYNC_RENDER_USER_DATA";
const MODULE_ROOT_ENV = "NETCATTY_XTERM_SYNC_RENDER_MODULE_ROOT";
const EXPECT_UNPATCHED_ENV = "NETCATTY_XTERM_SYNC_RENDER_EXPECT_UNPATCHED";

if (!process.versions.electron && process.env[LIVE_ENV] !== "1") {
  const test = require("node:test");
  test("closed synchronized-output frames render before the next frame opens", {
    skip: "run npm run test:xterm-sync-render for the Electron behavior test",
  }, () => {});
} else if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const electronPath = require("electron");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-sync-render-"));
  const result = spawnSync(electronPath, [__filename], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, [USER_DATA_ENV]: userData },
    stdio: "inherit",
    timeout: 30_000,
  });
  fs.rmSync(userData, { recursive: true, force: true });
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} else {
  const assert = require("node:assert/strict");
  const { pathToFileURL } = require("node:url");
  const electron = require("electron");

  const appRoot = path.resolve(__dirname, "..");
  const userData = process.env[USER_DATA_ENV];
  assert.ok(userData, `${USER_DATA_ENV} is required`);
  electron.app.setPath("userData", userData);
  electron.app.commandLine.appendSwitch("disable-gpu");

  let window;
  let finished = false;
  const finish = (exitCode, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimeout);
    if (error) console.error(error);
    try {
      if (window && !window.isDestroyed()) window.destroy();
    } finally {
      electron.app.exit(exitCode);
    }
  };
  const hardTimeout = setTimeout(() => {
    finish(1, new Error("xterm synchronized-render Electron test timed out"));
  }, 20_000);

  void electron.app.whenReady().then(async () => {
    window = new electron.BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    const htmlFile = path.join(userData, "xterm-sync-render.html");
    fs.writeFileSync(
      htmlFile,
      "<!doctype html><style>html,body,#terminal{width:600px;height:320px;margin:0}</style><div id=terminal></div>",
    );
    await window.loadFile(htmlFile);

    const moduleRoot = process.env[MODULE_ROOT_ENV] || appRoot;
    const expectUnpatched = process.env[EXPECT_UNPATCHED_ENV] === "1";
    const cjsPath = require.resolve("@xterm/xterm", { paths: [moduleRoot] });
    const esmPath = path.join(path.dirname(cjsPath), "xterm.mjs");
    const loaders = [
      { name: "cjs", expression: `require(${JSON.stringify(cjsPath)})` },
      { name: "esm", expression: `await import(${JSON.stringify(pathToFileURL(esmPath).href)})` },
    ];
    const scenarios = [
      {
        name: "split-input",
        chunks: [
          "\x1b[?2026h\x1b[1;1HAAAAAAAAAA",
          "\x1b[2;1HBBBBBBBBBB\x1b[?2026l",
          "\x1b[?2026h\x1b[1;1HCC",
        ],
      },
      {
        name: "close-and-next-open-together",
        chunks: [
          "\x1b[?2026h\x1b[1;1HAAAAAAAAAA",
          "\x1b[2;1HBBBBBBBBBB\x1b[?2026l\x1b[?2026h\x1b[1;1HCC",
        ],
      },
      {
        name: "complete-and-next-frame-together",
        chunks: [
          "\x1b[?2026h\x1b[1;1HAAAAAAAAAA\x1b[2;1HBBBBBBBBBB\x1b[?2026l\x1b[?2026h\x1b[1;1HCC",
        ],
      },
    ];
    for (const scenario of scenarios) {
      for (const chunk of scenario.chunks) {
        assert.equal(chunk.charCodeAt(0), 0x1b, `${scenario.name} must start with a real ESC byte`);
      }
    }
    const results = [];

    for (const loader of loaders) {
      for (const scenario of scenarios) {
        const result = await window.webContents.executeJavaScript(`(async () => {
        const { Terminal } = ${loader.expression};
        const target = document.getElementById("terminal");
        target.replaceChildren();
        const term = new Terminal({ cols: 10, rows: 2, cursorBlink: false });
        term.open(target);

        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();

        const renders = [];
        const renderSubscription = term.onRender(event => renders.push(event));
        const write = data => new Promise(resolve => term.write(data, resolve));
        for (const chunk of ${JSON.stringify(scenario.chunks)}) await write(chunk);
        await nextFrame();
        await nextFrame();
        const rendersBeforeSecondFrameClose = renders.length;

        await write("\\x1b[?2026l");
        await nextFrame();
        renderSubscription.dispose();
        term.dispose();
        return { rendersBeforeSecondFrameClose };
        })()`);
        if (expectUnpatched) {
          assert.equal(
            result.rendersBeforeSecondFrameClose,
            0,
            `${loader.name}/${scenario.name} unexpectedly passed without the patch: ${JSON.stringify(result)}`,
          );
        } else {
          assert.ok(
            result.rendersBeforeSecondFrameClose > 0,
            `${loader.name}/${scenario.name} did not render the completed first frame before the second opened: ${JSON.stringify(result)}`,
          );
        }
        results.push({ build: loader.name, scenario: scenario.name, ...result });
      }

      const redundantClose = await window.webContents.executeJavaScript(`(async () => {
        const { Terminal } = ${loader.expression};
        const target = document.getElementById("terminal");
        target.replaceChildren();
        const term = new Terminal({ cols: 10, rows: 2, cursorBlink: false });
        term.open(target);
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        await nextFrame();
        await nextFrame();
        const renders = [];
        const renderSubscription = term.onRender(event => renders.push(event));
        await new Promise(resolve => term.write("\\x1b[?2026l".repeat(100), resolve));
        const immediate = renders.length;
        await nextFrame();
        await nextFrame();
        const afterFrame = renders.length;
        renderSubscription.dispose();
        term.dispose();
        return { immediate, afterFrame };
      })()`);
      assert.equal(
        redundantClose.immediate,
        0,
        `${loader.name} rendered redundant synchronized-output closes immediately: ${JSON.stringify(redundantClose)}`,
      );
      assert.ok(
        redundantClose.afterFrame > 0,
        `${loader.name} did not preserve the normal deferred refresh for redundant closes: ${JSON.stringify(redundantClose)}`,
      );
      results.push({ build: loader.name, scenario: "redundant-close", ...redundantClose });
    }

    const label = expectUnpatched ? "XTERM_SYNC_RENDER_BASELINE_OK" : "XTERM_SYNC_RENDER_OK";
    process.stdout.write(`${label} ${JSON.stringify(results)}\n`);
    finish(0);
  }).catch((error) => finish(1, error));
}
