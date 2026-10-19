"use strict";
/* global process, __dirname, console */

if (!process.versions.electron) {
  require("node:test")("large snippet libraries keep argument completion responsive", {
    skip: "run with Electron to measure the actual renderer completion path",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow } = require("electron");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("snippet-completion-perf")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let window;
  const cleanup = (code) => {
    window?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };

  void app.whenReady().then(async () => {
    const root = path.resolve(__dirname, "..");
    const bundle = esbuild.buildSync({
      stdin: {
        contents: [
          'export { getCompletions } from "./components/terminal/autocomplete/completionEngine";',
          'export { resetPinyinCacheForTests, getPinyinCacheStatsForTests } from "./lib/searchMatcher";',
        ].join("\n"),
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      format: "cjs",
      platform: "browser",
      write: false,
      define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
    }).outputFiles[0].text;
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
    });
    await window.loadURL("data:text/html,<body>");
    const result = await window.webContents.executeJavaScript(`(async () => {
      const loaded = { exports: {} };
      ((module, exports) => { ${bundle} })(loaded, loaded.exports);
      const { getCompletions, resetPinyinCacheForTests, getPinyinCacheStatsForTests } = loaded.exports;
      const snippets = Array.from({ length: 5000 }, (_, index) => ({
        id: String(index), label: 'deploy-service-' + index,
        command: 'kubectl --namespace production rollout restart deployment service-' + index,
      }));
      snippets.push({ id: 'mail', label: '邮箱', command: 'user@example.com' });
      await getCompletions('git pull zz', { snippets: [] });
      resetPinyinCacheForTests();
      const rows = [];
      for (let round = 0; round < 3; round++) {
        for (const input of ['git pull zz', 'git pull zzq', 'git pull zzqx']) {
          const started = performance.now();
          let resolveInput;
          const inputTurn = new Promise(resolve => { resolveInput = resolve; });
          setTimeout(() => resolveInput(performance.now() - started), 0);
          const suggestions = await getCompletions(input, { snippets, skipPathCompletion: true });
          const completionMs = performance.now() - started;
          rows.push({ round, input, completionMs, inputDelayMs: await inputTurn, matches: suggestions.length });
        }
      }
      const pinyinKeys = getPinyinCacheStatsForTests().keys;
      const chinese = await getCompletions('git pull yx', { snippets, skipPathCompletion: true });
      return { rows, pinyinKeys, chineseSnippetId: chinese.find(item => item.source === 'snippet')?.snippet?.id };
    })()`);
    assert.ok(result.rows.every(row => row.matches === 0));
    assert.deepEqual(result.pinyinKeys, ["邮箱"], "ASCII command words must bypass transliteration");
    assert.equal(result.chineseSnippetId, "mail", "Chinese initials must still reach the snippet");
    // Report timings without a machine-dependent threshold. The cache-work
    // assertion above is the deterministic regression gate on this real path.
    console.log("TERMINAL_SNIPPET_COMPLETION_PERFORMANCE_OK", JSON.stringify(result));
    cleanup(0);
  }).catch(error => { console.error(error); cleanup(1); });
}
