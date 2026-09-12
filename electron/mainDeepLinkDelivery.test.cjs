const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const deepLink = require("./deepLink.cjs");

const source = readFileSync(require.resolve("./main.cjs"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

// Execute the main process's actual queue, preference handler, and delivery
// functions. Only desktop services and renderer readiness are controlled here.
function createHarness() {
  const handlers = new Map();
  const deliveries = [];
  const waiting = [];
  const timers = [];
  const sandbox = {
    ...deepLink,
    process: { argv: ["netcatty"] },
    app: { isReady: () => false },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isDev: false,
    readSshDeepLinkEnabledPreference: () => true,
    readJmsDeepLinkEnabledPreference: () => false,
    resolveOpenTerminalPathsFromArgs: () => [],
    resolveExplorerContextMenuEnabled: () => ({ enabled: false }),
    applySshProtocolClientPreference: () => true,
    writeSshDeepLinkEnabledPreference: () => true,
    createAndShowMainWindow: async () => ({}),
    focusMainWindow: () => {},
    getWindowManager: () => ({
      sendWhenRendererReady: (_win, channel, payload, options) => new Promise((resolve) => {
        waiting.push({ channel, payload, options, resolve });
      }),
    }),
    setTimeout: (callback) => timers.push(callback),
    console: { warn: () => {} },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext([
    section("let sshDeepLinkEnabled =", 'ipcMain?.handle?.("netcatty:deepLink:jms:setEnabled"'),
    section("async function deliverSshDeepLink(", "async function deliverOpenTerminalPath("),
    `globalThis.launch = {
      ssh: { queue: queueSshDeepLink, flush: flushPendingSshDeepLinks, pending: pendingSshDeepLinkUrls },
      telnet: { queue: queueTelnetDeepLink, flush: flushPendingTelnetDeepLinks, pending: pendingTelnetDeepLinkUrls },
    };`,
  ].join("\n"), context);

  return {
    launch: context.launch,
    deliveries,
    timers,
    async setEnabled(enabled) {
      await handlers.get("netcatty:deepLink:ssh:setEnabled")(null, { enabled });
    },
    async nextDelivery() {
      for (let attempt = 0; attempt < 20 && waiting.length === 0; attempt++) await Promise.resolve();
      assert.ok(waiting.length > 0, "delivery must reach renderer readiness");
      const item = waiting.shift();
      return {
        finish(result) {
          if (result) return item.resolve(result);
          if (!item.options.shouldSend()) {
            return item.resolve({ success: false, reason: item.options.cancelReason });
          }
          deliveries.push({ channel: item.channel, url: item.payload.url });
          item.resolve({ success: true });
        },
      };
    },
  };
}

for (const protocol of ["ssh", "telnet"]) {
  test(`${protocol}: disable/re-enable permanently cancels an in-flight scheme request`, async () => {
    const h = createHarness();
    const queue = h.launch[protocol];
    queue.queue(`${protocol}://old.example`);
    const flushing = queue.flush();
    const old = await h.nextDelivery();
    await h.setEnabled(false);
    await h.setEnabled(true);
    old.finish();
    await flushing;
    assert.deepEqual(h.deliveries, []);
    assert.equal(queue.pending.length, 0);
    assert.equal(h.timers.length, 0);
  });

  test(`${protocol}: cancelled schemes cannot return through a failed-delivery retry`, async () => {
    const h = createHarness();
    const queue = h.launch[protocol];
    queue.queue(`${protocol}://old.example`);
    const flushing = queue.flush();
    const old = await h.nextDelivery();
    await h.setEnabled(false);
    await h.setEnabled(true);
    old.finish({ success: false, reason: "window-destroyed" });
    await flushing;
    assert.equal(queue.pending.length, 0, "a cancelled request must not be requeued");
    assert.equal(h.timers.length, 0);
  });

  test(`${protocol}: disabling removes queued schemes but preserves queued CLI and new requests`, async () => {
    const h = createHarness();
    const queue = h.launch[protocol];
    queue.queue(`${protocol}://old.example`);
    queue.queue(`${protocol}://queued-old.example`);
    queue.queue(`${protocol}://cli.example`, { viaCommandLine: true });
    const flushing = queue.flush();
    const old = await h.nextDelivery();
    await h.setEnabled(false);
    await h.setEnabled(true);
    queue.queue(`${protocol}://new.example`);
    old.finish();
    (await h.nextDelivery()).finish();
    (await h.nextDelivery()).finish();
    await flushing;
    assert.deepEqual(h.deliveries.map((item) => item.url), [
      `${protocol}://cli.example`, `${protocol}://new.example`,
    ]);
  });

  test(`${protocol}: an in-flight CLI request survives disabling and re-enabling schemes`, async () => {
    const h = createHarness();
    const queue = h.launch[protocol];
    queue.queue(`${protocol}://cli.example`, { viaCommandLine: true });
    const flushing = queue.flush();
    const cli = await h.nextDelivery();
    await h.setEnabled(false);
    await h.setEnabled(true);
    cli.finish();
    await flushing;
    assert.deepEqual(h.deliveries.map((item) => item.url), [`${protocol}://cli.example`]);
  });

  test(`${protocol}: CLI retries remain queued when schemes are disabled`, async () => {
    const h = createHarness();
    const queue = h.launch[protocol];
    queue.queue(`${protocol}://cli.example`, { viaCommandLine: true });
    const flushing = queue.flush();
    const cli = await h.nextDelivery();
    await h.setEnabled(false);
    cli.finish({ success: false, reason: "window-destroyed" });
    await flushing;
    assert.equal(queue.pending.length, 1);
    assert.equal(h.timers.length, 1);
    assert.equal(queue.pending[0].rawUrl, `${protocol}://cli.example`);
  });
}
