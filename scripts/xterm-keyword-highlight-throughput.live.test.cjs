"use strict";

/* global process, __dirname, console */

if (!process.versions.electron) {
  const test = require("node:test");
  test("keyword highlighting keeps sustained output responsive", {
    skip: "run with Electron so the real WebGL renderer is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const electron = require("electron");
  const esbuild = require("esbuild");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

  const appRoot = path.resolve(__dirname, "..");
  const mainRef = process.env.NETCATTY_TERMINAL_PERF_MAIN_REF ?? "origin/main";
  const chunkCount = Number.parseInt(process.env.NETCATTY_TERMINAL_PERF_CHUNKS ?? "1600", 10);
  const roundCount = Number.parseInt(process.env.NETCATTY_TERMINAL_PERF_ROUNDS ?? "3", 10);
  const scrollback = Number.parseInt(
    process.env.NETCATTY_TERMINAL_PERF_SCROLLBACK ?? "50000",
    10,
  );
  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("xterm-highlight-throughput")}-`);
  electron.app.setPath("userData", userData);
  electron.app.commandLine.appendSwitch("js-flags", "--expose-gc");
  electron.app.on("window-all-closed", () => {});
  let window = null;

  const cleanup = (exitCode) => {
    if (window && !window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove xterm throughput test data:", error);
    } finally {
      electron.app.exit(exitCode);
    }
  };

  const buildModule = (source, resolveDir, plugins = []) => esbuild.buildSync({
    stdin: { contents: source, loader: "ts", resolveDir },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "chrome142",
    write: false,
    plugins,
  }).outputFiles[0].text;

  const buildMainModule = async () => {
    const entryPath = "components/terminal/__keywordHighlightThroughputEntry.ts";
    const entrySource = [
      'export * from "./keywordHighlight";',
      'export { noteTerminalOutputPressureData } from "./runtime/terminalOutputPressure";',
    ].join("\n");
    const resolveMainFile = (repoPath) => {
      const candidates = repoPath === entryPath
        ? [entryPath]
        : [repoPath, `${repoPath}.ts`, `${repoPath}.tsx`, `${repoPath}/index.ts`, `${repoPath}/index.tsx`];
      for (const candidate of candidates) {
        if (candidate === entryPath) return candidate;
        const exists = childProcess.spawnSync(
          "git",
          ["cat-file", "-e", `${mainRef}:${candidate}`],
          { cwd: appRoot, stdio: "ignore" },
        ).status === 0;
        if (exists) return candidate;
      }
      throw new Error(`Unable to resolve ${mainRef} source: ${repoPath}`);
    };
    const readMainFile = (repoPath) => repoPath === entryPath
      ? entrySource
      : childProcess.execFileSync("git", ["show", `${mainRef}:${repoPath}`], {
        cwd: appRoot,
        encoding: "utf8",
      });
    const mainPlugin = {
      name: "main-source",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind !== "entry-point") return undefined;
          return { path: entryPath, namespace: "main-source" };
        });
        build.onResolve({ filter: /^\.\.?\// }, (args) => ({
          path: resolveMainFile(
            path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path)),
          ),
          namespace: "main-source",
        }));
        build.onLoad({ filter: /.*/, namespace: "main-source" }, (args) => ({
          contents: readMainFile(args.path),
          loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".tsx") ? "tsx" : "ts",
          resolveDir: path.posix.dirname(args.path),
        }));
      },
    };
    return (await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "chrome142",
      write: false,
      plugins: [mainPlugin],
    })).outputFiles[0].text;
  };

  void electron.app.whenReady().then(async () => {
    const oldBundle = await buildMainModule();
    const currentBundle = buildModule([
      `export * from ${JSON.stringify(path.join(appRoot, "components/terminal/keywordHighlight.ts"))};`,
      `export { noteTerminalOutputPressureData } from ${JSON.stringify(path.join(appRoot, "components/terminal/runtime/terminalOutputPressure.ts"))};`,
    ].join("\n"), appRoot);

    window = new electron.BrowserWindow({
      show: process.env.NETCATTY_TERMINAL_PERF_SHOW_WINDOW === "1",
      width: 1000,
      height: 640,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body,#terminal{width:920px;height:560px;margin:0}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const webglPath = require.resolve("@xterm/addon-webgl", { paths: [appRoot] });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const { WebglAddon } = require(${JSON.stringify(webglPath)});
      const loadBundle = source => {
        const loaded = { exports: {} };
        ((module, exports) => { eval(source); })(loaded, loaded.exports);
        return loaded.exports;
      };
      const oldModule = loadBundle(${JSON.stringify(oldBundle)});
      const currentModule = loadBundle(${JSON.stringify(currentBundle)});
      const rules = [
        { id: "info", label: "Info", patterns: ["INFO"], color: "#60A5FA", enabled: true },
        { id: "warn", label: "Warn", patterns: ["WARN"], color: "#FBBF24", enabled: true },
        { id: "error", label: "Error", patterns: ["ERROR", "failed"], color: "#F87171", enabled: true },
        { id: "ip", label: "IP", patterns: ["10\\\\.2\\\\.\\\\d+\\\\.\\\\d+"], color: "#4ADE80", enabled: true },
      ];
      const makeChunk = index => {
        let chunk = "";
        for (let line = 0; line < 64; line += 1) {
          chunk += "2026-08-13 INFO worker=" + (line % 32) + " WARN ERROR failed from 10.2."
            + ((index + line) % 255) + "." + ((index * 7 + line) % 255) + " payload="
            + "x".repeat(24) + "\\r\\n";
        }
        return chunk;
      };
      const chunks = Array.from({ length: ${chunkCount} }, (_, index) => makeChunk(index));
      const totalChars = chunks.reduce((total, chunk) => total + chunk.length, 0);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      const run = async kind => {
        document.getElementById("terminal").replaceChildren();
        globalThis.gc?.();
        await wait(20);
        const v8 = require("node:v8");
        const heapBefore = v8.getHeapStatistics().used_heap_size;
        const term = new Terminal({
          allowProposedApi: true,
          cols: 120,
          cursorBlink: false,
          rows: 40,
          scrollback: ${scrollback},
        });
        term.open(document.getElementById("terminal"));
        let renderer = "dom";
        try {
          term.loadAddon(new WebglAddon());
          renderer = "webgl";
        } catch {}
        const selectedModule = kind === "old" ? oldModule : currentModule;
        const Highlighter = kind === "old"
          ? oldModule.KeywordHighlighter
          : currentModule.KeywordHighlighter;
        const highlighter = kind === "raw" ? null : new Highlighter(term);
        highlighter?.setRules(rules, true);
        const sustainedOnly = process.env.NETCATTY_TERMINAL_PERF_SUSTAINED_ONLY === "1";
        let maxPendingPristineBytes = 0;
        const pendingSample = setInterval(() => {
          maxPendingPristineBytes = Math.max(
            maxPendingPristineBytes,
            highlighter?.pendingPristineBytes ?? 0,
          );
        }, 5);
        const write = data => new Promise(resolve => term.write(data, resolve));
        const callbackLatencies = [];
        const heartbeatLatencies = [];
        let heartbeatAt = performance.now();
        const heartbeat = setInterval(() => {
          const now = performance.now();
          heartbeatLatencies.push(now - heartbeatAt);
          heartbeatAt = now;
        }, 10);
        let renders = 0;
        const renderDisposable = term.onRender(() => { renders += 1; });
        const streamStarted = performance.now();
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          selectedModule.noteTerminalOutputPressureData(term, chunk);
          const callbackStarted = performance.now();
          await write(chunk);
          callbackLatencies.push(performance.now() - callbackStarted);
          if (index % 16 === 15) await wait(0);
        }
        const streamMs = performance.now() - streamStarted;
        const rendersAtStreamEnd = renders;
        const quietStarted = performance.now();
        await wait(sustainedOnly ? 0 : 700);
        const quietDelayMs = performance.now() - quietStarted;
        const streamHeartbeatCount = heartbeatLatencies.length;
        const streamMaxHeartbeatMs = Math.max(0, ...heartbeatLatencies);
        const rendersBeforeSettle = renders;
        const settleStarted = performance.now();
        if (!sustainedOnly) await highlighter?.whenSettled?.();
        const settleWaitMs = performance.now() - settleStarted;
        const rendersDuringSettle = renders - rendersBeforeSettle;
        const quietWorkMs = performance.now() - quietStarted - (sustainedOnly ? 0 : 700);
        let paintTimedOut = false;
        if (!sustainedOnly) {
          await Promise.race([
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            wait(1000).then(() => { paintTimedOut = true; }),
          ]);
        }
        const rendersAfterSettle = renders - rendersBeforeSettle - rendersDuringSettle;
        const quietCatchUpMs = performance.now() - quietStarted - (sustainedOnly ? 0 : 700);
        clearInterval(heartbeat);
        clearInterval(pendingSample);
        globalThis.gc?.();
        await wait(20);
        const heapAfter = v8.getHeapStatistics().used_heap_size;
        callbackLatencies.sort((left, right) => left - right);
        const percentile = value => callbackLatencies[Math.min(
          callbackLatencies.length - 1,
          Math.floor(callbackLatencies.length * value),
        )];
        const state = {
          kind,
          renderer,
          streamMs,
          mibPerSecond: totalChars / 1024 / 1024 / (streamMs / 1000),
          callbackP50Ms: percentile(0.5),
          callbackP95Ms: percentile(0.95),
          callbackP99Ms: percentile(0.99),
          maxHeartbeatMs: streamMaxHeartbeatMs,
          maxCatchUpHeartbeatMs: Math.max(0, ...heartbeatLatencies.slice(streamHeartbeatCount)),
          quietCatchUpMs,
          quietWorkMs,
          quietDelayMs,
          settleWaitMs,
          paintTimedOut,
          rendersDuringStream: rendersAtStreamEnd,
          rendersDuringSettle,
          rendersAfterSettle,
          heapDeltaMiB: (heapAfter - heapBefore) / 1024 / 1024,
          rebuildCount: highlighter?.rebuildCount ?? 0,
          rebuildTimings: highlighter?.lastRebuildTimings ?? {},
          maxPendingPristineBytes,
        };
        renderDisposable.dispose();
        highlighter?.dispose();
        term.dispose();
        return state;
      };

      const rounds = [];
      for (let round = 0; round < ${roundCount}; round += 1) {
        for (const kind of ["raw", "old", "new"]) rounds.push(await run(kind));
      }
      return { totalChars, chunks: chunks.length, rounds };
    })()`, true);

    if (process.env.NETCATTY_TERMINAL_PERF_REQUIRE_WEBGL === "1") {
      for (const round of result.rounds) assert.equal(round.renderer, "webgl", JSON.stringify(round));
    }
    const median = values => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const byKind = kind => result.rounds.filter(round => round.kind === kind);
    const oldStreamMs = median(byKind("old").map(round => round.streamMs));
    const newStreamMs = median(byKind("new").map(round => round.streamMs));
    const oldP99Ms = median(byKind("old").map(round => round.callbackP99Ms));
    const newP99Ms = median(byKind("new").map(round => round.callbackP99Ms));
    const oldHeartbeatMs = median(byKind("old").map(round => round.maxHeartbeatMs));
    const newHeartbeatMs = median(byKind("new").map(round => round.maxHeartbeatMs));
    const newCatchUpHeartbeatMs = median(byKind("new").map(round => round.maxCatchUpHeartbeatMs));
    const newQuietCatchUpMs = median(byKind("new").map(round => round.quietCatchUpMs));
    // Catch-up is deliberately deferred until output becomes quiet. Keep a
    // strict event-loop stall limit, while allowing total work to scale with
    // the retained history size (5s at 10k lines, 10s at 50k lines).
    const maxQuietCatchUpMs = Math.max(5000, scrollback / 5);
    const rawStreamMs = median(byKind("raw").map(round => round.streamMs));
    const rawP99Ms = median(byKind("raw").map(round => round.callbackP99Ms));
    assert.ok(
      newStreamMs <= oldStreamMs * 1.1,
      `new sustained throughput regressed more than 10%: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newP99Ms <= oldP99Ms * 1.15,
      `new p99 write latency regressed more than 15%: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newHeartbeatMs <= Math.max(75, oldHeartbeatMs * 3),
      `new event-loop stall regressed: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newCatchUpHeartbeatMs <= 350,
      `quiet catch-up blocked the event loop for over 350 ms: ${JSON.stringify(result)}`,
    );
    // Product gate is vs main decorations (10% above). Raw xterm is a sanity
    // bound only: cell-color wrap + DOM CI is typically ~15-18% over raw.
    assert.ok(
      newStreamMs <= rawStreamMs * 1.25,
      `new sustained throughput regressed more than 25% versus raw xterm: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newP99Ms <= Math.max(10, rawP99Ms * 1.25),
      `new p99 write latency regressed versus raw xterm: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newQuietCatchUpMs <= maxQuietCatchUpMs,
      `quiet-period catch-up exceeded ${maxQuietCatchUpMs} ms: ${JSON.stringify(result)}`,
    );
    if (process.env.NETCATTY_TERMINAL_PERF_SUSTAINED_ONLY !== "1") {
      assert.equal(
        byKind("new").every(round => round.rebuildCount === 1),
        true,
        `bulk output must catch up exactly once after becoming quiet: ${JSON.stringify(result)}`,
      );
      assert.equal(
        byKind("new").every(round => !round.paintTimedOut && round.rendersDuringSettle <= 1),
        true,
        `quiet catch-up must repaint atomically: ${JSON.stringify(result)}`,
      );
      assert.equal(
        byKind("new").every(round => (round.rendersAfterSettle ?? 0) <= 1),
        true,
        `quiet catch-up must not keep painting after settle: ${JSON.stringify(result)}`,
      );
    }
    assert.equal(
      byKind("new").every(round => round.maxPendingPristineBytes <= 12 * 1024 * 1024),
      true,
      `pristine backlog must stay bounded: ${JSON.stringify(result)}`,
    );
    process.stdout.write(`XTERM_KEYWORD_HIGHLIGHT_THROUGHPUT ${JSON.stringify(result)}\n`);
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
