"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const windowManager = require("../bridges/windowManager.cjs");
const { createPluginHostService } = require("./hostService.cjs");
const { registerPluginBridge, createTrustedPluginBridgeSender } = require("./pluginBridge.cjs");
const { inProcessBrowserRuntime } = require("./fixtures/inProcessBrowserRuntime.cjs");

// Real manager, registered host/view RPCs, SDK activation and managed Settings
// creation. Only Electron's native window/contents boundary is represented here.
test("Settings-owned installed view can Ask on activation and commands without a main-window focus handoff", { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-permission-windows-"));
  const handlers = new Map(), windows = [], owners = new Map();
  let nextId = 1, service;
  class Contents extends EventEmitter {
    constructor() { super(); this.id = nextId++; this.messages = []; this.url = "app://netcatty/index.html"; this.mainFrame = { url: this.url, parent: null }; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    isCrashed() { return false; }
    getURL() { return this.url; }
    setWindowOpenHandler() {}
    async loadURL(url) { this.url = url; this.mainFrame.url = url; }
    send(channel, payload) { this.messages.push({ channel, payload }); this.emit(channel, payload); }
    focus() {}
    close() { this.destroyed = true; this.emit("destroyed"); }
  }
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new Contents(); owners.set(this.webContents, this); windows.push(this);
      this.destroyed = false; this.visible = false; this.focused = false; this.children = [];
      this.contentView = { addChildView: (view) => this.children.push(view), removeChildView: (view) => { this.children = this.children.filter((item) => item !== view); } };
    }
    static fromWebContents(sender) { return owners.get(sender) ?? null; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    show() { this.visible = true; }
    focus() { for (const window of windows) if (window !== this && window.focused) { window.focused = false; window.emit("blur"); } this.focused = true; this.emit("focus"); }
    hide() { this.visible = false; this.focused = false; this.emit("hide"); }
    destroy() { this.destroyed = true; this.focused = false; this.emit("closed"); this.webContents.close(); }
    async loadURL(url) { await this.webContents.loadURL(url); }
    getBounds() { return { x: 0, y: 0, width: 980, height: 720 }; }
    setBackgroundColor() {}
    setOpacity() {}
  }
  class ContentsView {
    constructor() { this.webContents = new Contents(); }
    setBounds() {}
    setVisible(visible) { this.visible = visible; }
  }
  const ipcMain = Object.assign(new EventEmitter(), { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) });
  const electron = { ipcMain, BrowserWindow: Window, WebContentsView: ContentsView, shell: {},
    session: { fromPartition: () => Object.assign(new EventEmitter(), { protocol: { handle() {}, unhandle() {} }, setProxy: async () => {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest() {} } }) } };
  const main = new Window(); main.show(); main.focus(); windowManager.registerMainWindow(main);
  const settings = await windowManager.openSettingsWindow(electron, { isDev: false, isMac: false, preload: "synthetic-preload.cjs", sourceWindow: main });
  assert.equal(windowManager.getSettingsWindow(), settings); assert.equal(settings.isFocused(), true); assert.equal(main.isFocused(), false);
  // The fallback permits running this regression on the original 79 tree;
  // production uses the managed registry's new combined getter.
  const getWindows = () => windowManager.getManagedAppWindows?.() ?? [...windowManager.getAppContentWindows(), windowManager.getSettingsWindow()].filter(Boolean);
  service = createPluginHostService({ app: { getAppPath: () => process.cwd(), getPath: () => root, getVersion: () => "0.0.0" }, electron, env: {},
    getInteractionWindow: () => main, getPermissionWindows: getWindows, isAppLocked: () => false });
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  registerPluginBridge(ipcMain, { ...service, isTrustedSender: createTrustedPluginBridgeSender() });
  const event = (sender) => ({ sender, senderFrame: sender.mainFrame });
  const call = (sender, name, payload) => handlers.get(`netcatty:plugins:${name}`)(event(sender), payload);
  const ready = (window, value = true) => call(window.webContents, "permission-ready", { ready: value });
  const promptCount = (window) => window.webContents.messages.filter((item) => item.channel === "netcatty:plugins:permission-prompt" && !item.payload.closed).length;
  const nextPrompt = (window) => new Promise((resolve) => {
    const listener = (prompt) => { if (!prompt.closed) { window.webContents.removeListener("netcatty:plugins:permission-prompt", listener); resolve(prompt); } };
    window.webContents.on("netcatty:plugins:permission-prompt", listener);
  });
  const response = (prompt, decision = "allow") => ({ requestId: prompt.requestId, actionToken: prompt.actionToken, decision });
  const id = "com.netcatty.permission-window-test";
  t.after(async () => {
    await service.manager.shutdown(); windowManager.unregisterMainWindow(main); windowManager.closeSettingsWindow();
    await fs.rm(root, { recursive: true, force: true });
  });
  await service.manager.initialize(); await ready(main);
  // Original implementation rejects this registration and subsequently fails
  // the activation with provider-failed while Settings owns focus.
  await ready(settings).catch(() => {});
  const manifest = { manifestVersion: 1, id, name: "permission-window-test", version: "1.0.0", publisher: "netcatty",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" }, main: { browser: "browser.js" },
    activationEvents: [`onView:${id}.panel`], permissions: { required: ["settings.read", "commands", "views"] },
    contributes: { settings: [{ id: `${id}.greeting`, label: "Greeting", control: "text", scope: "application", default: "synthetic greeting" }],
      commands: [{ id: `${id}.read`, title: "Read own setting" }], views: [{ id: `${id}.panel`, title: "Settings-owned panel", location: "panel" }] } };
  const staging = path.join(root, "package"); await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, "netcatty.plugin.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(staging, "panel.html"), "<!doctype html><p>Synthetic view</p>");
  await fs.writeFile(path.join(staging, "browser.js"), `export default { async activate(context) {
    await context.settings.get(${JSON.stringify(`${id}.greeting`)});
    context.subscriptions.add(context.commands.registerCommand(${JSON.stringify(`${id}.read`)}, () => context.settings.get(${JSON.stringify(`${id}.greeting`)})));
  } };`);
  const { buildPluginPackage } = await import("@netcatty/plugin-cli");
  const archive = path.join(root, "fixture.ncpkg"); await buildPluginPackage(staging, archive); await service.manager.install(archive, { enable: true });
  const plugin = service.database.getActivePlugin(id); await service.permissionEngine.setMode(plugin, "settings.read", "ask");
  const openedPrompt = nextPrompt(settings);
  const opening = call(settings.webContents, "host-ui-open", { viewId: `${id}.panel`, scopeId: "window:settings", instanceId: "settings-view" });
  const prompt = await Promise.race([openedPrompt, opening.then(() => { throw new Error("Activation skipped its settings Ask"); })]);
  assert.equal(prompt.permission, "settings.read"); assert.equal(promptCount(main), 0);
  assert.equal(main.isFocused(), false, "Ask must not steal focus or close the originating view");
  await call(settings.webContents, "permission-response", response(prompt));
  const opened = await opening;
  const instance = service.hostDrawnViewHost.instances.get(opened.instanceId);
  assert.equal(instance.owner, settings); assert.equal(settings.children.length, 0);
  const read = () => call(settings.webContents, "execute-command", { command: `${id}.read` });
  const asked = nextPrompt(settings); const reading = read(); const commandPrompt = await asked;
  await ready(main, false); // Another renderer's teardown cannot cancel Settings.
  assert.equal(service.permissionDecisionHost.pending.size, 1);
  const foreign = new Window(); foreign.show(); // Same app URL, but unmanaged.
  await assert.rejects(ready(foreign), /sender is invalid/);
  const pluginSender = new Contents(); pluginSender.url = "netcatty-plugin://untrusted/index.html"; pluginSender.mainFrame.url = pluginSender.url;
  await assert.rejects(call(pluginSender, "permission-response", response(commandPrompt)), /Untrusted/);
  const childFrame = { url: settings.webContents.getURL(), parent: settings.webContents.mainFrame };
  await assert.rejects(handlers.get("netcatty:plugins:permission-ready")({ sender: settings.webContents, senderFrame: childFrame }, { ready: true }), /Untrusted|frame/);
  await assert.rejects(handlers.get("netcatty:plugins:permission-ready")({ sender: settings.webContents, senderFrame: null }, { ready: true }), /Untrusted|frame/);
  await assert.rejects(handlers.get("netcatty:plugins:permission-response")({ sender: settings.webContents, senderFrame: childFrame }, response(commandPrompt)), /Untrusted|frame/);
  await call(settings.webContents, "permission-response", response(commandPrompt)); assert.equal(await reading, "synthetic greeting");
  await ready(main); main.show(); main.focus();
  const mainPrompt = nextPrompt(main); const mainRead = call(main.webContents, "execute-command", { command: `${id}.read` });
  await call(main.webContents, "permission-response", response(await mainPrompt)); assert.equal(await mainRead, "synthetic greeting");
  await ready(main, false);
  await assert.rejects(read(), /permission|decision/i); // Never fall back to a ready background Settings window.
  await ready(main);
  main.hide(); foreign.focus();
  const before = promptCount(main) + promptCount(settings);
  await assert.rejects(read(), /permission|decision/i);
  assert.equal(promptCount(main) + promptCount(settings), before, "foreign/background focus cannot receive or redirect a prompt");
  settings.show(); settings.focus();
  const hidingPrompt = nextPrompt(settings); const hiddenRead = read(); const hiddenRejected = assert.rejects(hiddenRead, /denied|cancel/i);
  const hiddenToken = response(await hidingPrompt); settings.hide(); await hiddenRejected;
  settings.show(); settings.focus();
  assert.equal(await call(settings.webContents, "permission-response", hiddenToken), false, "reopening Settings cannot revive an old decision");
  const closingPrompt = nextPrompt(settings); const cancelled = read(); const rejected = assert.rejects(cancelled, /denied|cancel/i);
  const stale = response(await closingPrompt); settings.destroy(); await rejected;
  assert.equal(service.permissionDecisionHost.pending.size, 0); assert.equal(service.hostDrawnViewHost.instances.size, 0);
  await assert.rejects(call(settings.webContents, "permission-response", stale), /focused unlocked|Untrusted/);
});
