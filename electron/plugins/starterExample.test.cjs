"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("Starter panel renders the actual command result as text and reports denial", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const saved = new Map();
  for (const key of ["document", "MutationObserver", "HTMLElement", "Element", "Node"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  const subscriptions = [];
  try {
    const root = path.resolve(__dirname, "../../examples/plugins/starter-netcatty");
    const plugin = (await import(pathToFileURL(path.join(root, "dist/host.js")).href)).default;
    let command; let deny = false;
    const listeners = new Set();
    const greeting = '<img src=x onerror="alert(1)"> synthetic hello';
    await plugin.activate({
      subscriptions: { add(disposable) { subscriptions.push(disposable); } },
      commands: {
        registerCommand(id, handler) { assert.equal(id, "com.netcatty.starter.greet"); command = handler; return { dispose() {} }; },
        async executeCommand(id) { assert.equal(id, "com.netcatty.starter.greet"); if (deny) throw new Error("Denied"); return command(); },
      },
      settings: { get: async () => greeting },
      environment: { locale: "en", theme: "light", onDidChange: () => ({ dispose() {} }) },
      views: {
        postMessage: (_id, message) => { for (const receive of listeners) receive(message); },
        onDidReceiveMessage(_id, receive) { listeners.add(receive); return { dispose() { listeners.delete(receive); } }; },
      },
    });
    for (const receive of listeners) receive({ kind: "host-ui.open", instanceId: "test", stateScope: "test" });
    const button = dom.window.document.getElementById("greet");
    const result = dom.window.document.getElementById("result");
    assert.ok(button, "the bundled host entry mounts the starter view");
    const click = async () => {
      button.click();
      for (let i = 0; button.disabled && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(button.disabled, false);
    };
    await click();
    assert.equal(result.textContent, greeting);
    assert.equal(result.querySelector("img"), null);
    deny = true;
    await click();
    assert.match(result.textContent, /Check permission approval/);
  } finally {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
