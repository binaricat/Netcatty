"use strict";

// Exercise the production React lifecycle and native manager together, including
// the StrictMode mount replay used by the desktop development app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const dgram = require("node:dgram");
const ts = require("typescript");
const React = require("react");
const { create, act } = require("react-test-renderer");
const electron = require("electron");
const { app, BrowserWindow, WebContentsView } = electron;
const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");

function loadModule(file, globals) {
  const source = fs.readFileSync(path.join(__dirname, "../..", file), "utf8").replace(/^import .*;\n/gm, "");
  const context = { exports: {}, ...globals };
  vm.runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), context);
  return context.exports;
}

async function probeWebRtcUdp(contents) {
  const socket = dgram.createSocket('udp4');
  let packets = 0;
  socket.on('message', () => { packets += 1; });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    await contents.executeJavaScript(`(async () => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${socket.address().port}' }] });
      try {
        peer.createDataChannel('route-check');
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise(resolve => setTimeout(resolve, 1500));
      } finally { peer.close(); }
    })()`);
    return packets;
  } finally { socket.close(); }
}

async function main() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  app.setPath("userData", path.join(os.tmpdir(), `netcatty-browser-first-link-${process.pid}`));
  const site = http.createServer((_request, response) => response.end("<title>First click opened</title>"));
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const owner = new BrowserWindow({ width: 900, height: 760, show: false });
  const event = { sender: owner.webContents };
  const manager = createHostBrowserManager({ electron, app, portForwardingBridge });
  const opens = [];
  const bridge = {
    startPortForward: () => { throw new Error("Local browser must not create an SSH tunnel"); },
    setHostBrowserPanelLayout: async (input) => manager.updatePanelLayout(event, input),
    closeHostBrowserPanel: async (id) => manager.closePanel(event, id),
    openHostBrowser: (input) => { const operation = manager.open(event, input); opens.push(operation); return operation; },
  };
  const style = { colorScheme: "light", getPropertyValue: () => "" };
  const globals = { ...React, Map, Promise, Object, crypto: require("node:crypto").webcrypto,
    setTimeout, clearTimeout, queueMicrotask,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    document: { querySelector: () => null, querySelectorAll: () => [], documentElement: { classList: { contains: () => false } } },
    getComputedStyle: () => style, netcattyBridge: { get: () => bridge }, isValidHslToken: () => false,
  };
  const { mountHostBrowser, currentBrowserThemeTokens } = loadModule("application/hostBrowser.ts", globals);
  const { useHostBrowserPanel } = loadModule("application/state/useHostBrowserPanel.ts", { ...globals, mountHostBrowser, currentBrowserThemeTokens });
  const browserId = "local:first-link";
  const element = { isConnected: true, closest: () => null,
    getBoundingClientRect: () => ({ x: 200, y: 50, width: 420, height: 600 }) };
  function Panel() {
    const panel = useHostBrowserPanel({ browserId, host: { id: "local", protocol: "local", label: "Local terminal" },
      hosts: [], keys: [], identities: [], knownHosts: [], terminalSettings: {}, isVisible: true });
    return React.createElement("div", { ref: panel.elementRef });
  }
  let renderer;
  try {
    // A terminal click queues its URL before opening the previously closed pane.
    manager.openPanelUrl(event, { browserId, url });
    await act(async () => {
      renderer = create(React.createElement(React.StrictMode, null, React.createElement(Panel)), { createNodeMock: () => element });
    });
    await Promise.all(opens);
    const snapshot = manager.getPanelState(event, browserId);
    assert.equal(snapshot.tabs[0].url, url, "the first click must open its page without a second terminal click");
    let loadedTitle = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      loadedTitle = manager.getPanelState(event, browserId).tabs[0].title;
      if (loadedTitle === "First click opened") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(loadedTitle, "First click opened", "the first-click page must actually finish loading");
    const root = owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView
      && child.webContents.getURL() === url));
    assert.ok(root, "the first click must open the browser pane");
    assert.equal(root.children.length, 1, "only the website has a native view; controls belong to the app renderer");
    const page = root.children.find((view) => view instanceof WebContentsView && view.webContents.getURL() === url).webContents;
    assert.equal(page.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp');
    page.setWebRTCIPHandlingPolicy('default');
    assert.ok(await probeWebRtcUdp(page) > 0, 'the control must demonstrate direct UDP traffic');
    page.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    assert.equal(await probeWebRtcUdp(page), 0, 'browser pages must not bypass their route with direct WebRTC UDP');
    await act(async () => renderer.unmount());
    renderer = null;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(owner.contentView.children.includes(root), false, "a real unmount must still release the native browser");
    console.log(JSON.stringify({ ok: true, firstClickOpenedUrl: true, strictMode: true, webRtcUdpBlocked: true, cleanup: true }));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    manager.closeAll(); owner.destroy(); site.closeAllConnections(); site.close();
  }
  app.quit();
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
