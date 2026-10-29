"use strict";
/* global process, __dirname, clearTimeout, setTimeout, console */

// Render only the sample's HTML/CSS with synthetic text. No plugin, host bridge,
// provider, account configuration or Agent runtime is started by this test.
if (!process.versions.electron) {
  require("node:test")("global Agent sample preserves transcript and composer space", {
    skip: "run npm run test:plugin-global-agent-layout in the scheduled native QA environment",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow, session } = require("electron");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
  const sample = path.join(__dirname, "../examples/plugins/global-agent");
  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("agent-layout-test")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const finish = (code) => {
    clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  const watchdog = setTimeout(() => { console.error("AGENT_LAYOUT_FAIL timeout"); finish(1); }, 15_000);
  void app.whenReady().then(async () => {
    // Inline the real stylesheet and omit panel.js: even a broken layout has no
    // path to execute plugin commands or initiate model/credential requests.
    const html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>html,body{margin:0;height:100%}${fs.readFileSync(path.join(sample, "view.css"), "utf8")}</style>
      </head><body>${fs.readFileSync(path.join(sample, "view.html"), "utf8")}</body></html>`;
    const isolatedSession = session.fromPartition("agent-layout-synthetic");
    isolatedSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    win = new BrowserWindow({ show: false, useContentSize: true, width: 798, height: 548,
      webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    for (const qa of [false, true]) {
      const actual = await win.webContents.executeJavaScript(`(() => {
        const element = id => document.getElementById(id);
        element('qa').textContent = ${JSON.stringify(qa ? "Isolated deterministic fixture · no real model inference or paid API" : "")};
        element('transcript').textContent = 'assistant: ' + 'Synthetic owned conversation. '.repeat(100);
        element('usage').textContent = 'Input 12 · Output 6';
        element('activity').textContent = 'session.environment';
        element('status').textContent = 'Complete';
        element('stop').disabled = false;
        element('backend').innerHTML = '<option>Synthetic configured Catty</option>';
        element('conversation').innerHTML = '<option>Owned synthetic conversation</option>';
        const bounds = node => { const r = node.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height, width:r.width }; };
        const transcript = element('transcript');
        const setup = document.querySelector('.setup') || element('backend').closest('section');
        return { width:innerWidth, height:innerHeight, transcript:bounds(transcript),
          transcriptClient:transcript.clientHeight, transcriptScroll:transcript.scrollHeight,
          response:bounds(transcript.closest('section')), compose:bounds(element('compose')), stop:bounds(element('stop')),
          setup:bounds(setup), setupOverflow:getComputedStyle(setup).overflowY };
      })()`);
      const detail = JSON.stringify({ qa, ...actual });
      assert.equal(actual.width, 798, detail); assert.equal(actual.height, 548, detail);
      assert.ok(actual.response.height >= 180, `usable response card: ${detail}`);
      assert.ok(actual.transcriptClient >= 120, `visible conversation text: ${detail}`);
      assert.ok(actual.transcriptScroll > actual.transcriptClient, `transcript scrolls independently: ${detail}`);
      assert.ok(actual.compose.top >= actual.response.bottom - 1, `composer follows transcript: ${detail}`);
      assert.ok(actual.stop.bottom <= actual.height && actual.stop.height >= 30, `mouse Stop stays visible: ${detail}`);
      assert.ok(actual.setup.height >= 100 && actual.setupOverflow === "auto", `configuration stays reachable: ${detail}`);
      console.log(`AGENT_LAYOUT_PASS ${detail}`);
    }
    finish(0);
  }).catch((error) => { console.error("AGENT_LAYOUT_FAIL", error); finish(1); });
}
