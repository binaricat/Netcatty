import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTerminalLinkHandler } from "./terminalLinkHandler";

const click = {
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
} as MouseEvent;

test("terminal links default to the internal browser and apply settings immediately", async () => {
  const internal: string[] = [];
  const external: string[] = [];
  let systemBrowser = false;
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    openExternal: async (url) => { external.push(url); },
    openInternal: (url) => { internal.push(url); },
    useInternal: () => !systemBrowser,
    confirmOscLink: () => true,
  });
  await handler.open('http://localhost:3000/');
  systemBrowser = true;
  await handler.open('https://example.com/');
  assert.deepEqual(internal, ['http://localhost:3000/']);
  assert.deepEqual(external, ['https://example.com/']);
});

test("internal browser failures never fall back to the local system browser", async () => {
  const errors: unknown[] = [];
  let external = 0;
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    openExternal: async () => { external += 1; },
    openInternal: () => { throw new Error('Disconnected'); },
    confirmOscLink: () => true,
    onError: (error) => errors.push(error),
    warn: () => {},
  });
  await handler.open('http://localhost:3000/');
  assert.equal(external, 0);
  assert.equal(errors.length, 1);
});

test("OSC 8 links use the Netcatty external browser bridge", async () => {
  const opened: string[] = [];
  const confirmed: string[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    openExternal: async (uri) => opened.push(uri),
    confirmOscLink: (uri) => {
      confirmed.push(uri);
      return true;
    },
    openWindow: () => {
      throw new Error("window.open should not be used when the bridge is available");
    },
  });

  handler.activateOsc(click, "https://github.com/flyspray/flyspray");
  await Promise.resolve();

  assert.deepEqual(confirmed, ["https://github.com/flyspray/flyspray"]);
  assert.deepEqual(opened, ["https://github.com/flyspray/flyspray"]);
});

test("OSC 8 links do not open when the user rejects the safety confirmation", async () => {
  const opened: string[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    openExternal: async (uri) => opened.push(uri),
    confirmOscLink: () => false,
  });

  handler.activateOsc(click, "https://example.com");
  await Promise.resolve();

  assert.deepEqual(opened, []);
});

test("terminal links still honor the configured activation modifier", async () => {
  const opened: string[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => false,
    openExternalAvailable: () => true,
    openExternal: async (uri) => opened.push(uri),
    confirmOscLink: () => true,
  });

  handler.activate(click, "https://example.com");
  await Promise.resolve();

  assert.deepEqual(opened, []);
});

test("terminal links reject non-http protocols", async () => {
  const opened: string[] = [];
  const warnings: unknown[][] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    openExternal: async (uri) => opened.push(uri),
    confirmOscLink: () => true,
    warn: (...args) => warnings.push(args),
  });

  handler.activate(click, "file:///etc/passwd");
  await Promise.resolve();

  assert.deepEqual(opened, []);
  assert.equal(warnings.length, 1);
});

test("terminal links fall back to window.open when the bridge is unavailable", async () => {
  const opened: string[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => false,
    confirmOscLink: () => true,
    openExternal: async () => {
      throw new Error("bridge should not be used when unavailable");
    },
    openWindow: (uri) => opened.push(uri),
  });

  handler.activate(click, "https://example.com");
  await Promise.resolve();

  assert.deepEqual(opened, ["https://example.com"]);
});

test("terminal links do not report a noopener fallback as blocked", async () => {
  const failures: unknown[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => false,
    confirmOscLink: () => true,
    openExternal: async () => {
      throw new Error("bridge should not be used when unavailable");
    },
    openWindow: () => null,
    onError: (error) => failures.push(error),
  });

  await handler.open("https://example.com");

  assert.deepEqual(failures, []);
});

test("terminal link failures are reported to the UI", async () => {
  const failures: unknown[] = [];
  const handler = createTerminalLinkHandler({
    canActivate: () => true,
    openExternalAvailable: () => true,
    confirmOscLink: () => true,
    openExternal: async () => {
      throw new Error("no browser available");
    },
    onError: (error) => failures.push(error),
    warn: () => {},
  });

  handler.activate(click, "https://example.com");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /no browser available/);
});

test("the xterm OSC 8 provider is wired to the confirmed terminal link path", () => {
  const runtimeSource = readFileSync(
    new URL("./createXTermRuntime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    runtimeSource,
    /linkHandler:\s*\{\s*activate: terminalLinkHandler\.activateOsc,\s*\}/,
  );
});
