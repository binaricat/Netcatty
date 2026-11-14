const assert = require("node:assert/strict");
const test = require("node:test");

const { registerVendorAssistantHandlers } = require("./vendorAssistantHandlers.cjs");

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  };
}

test("registers the three vendor channels behind the sender guard", () => {
  const ipc = fakeIpc();
  registerVendorAssistantHandlers({ ipcMain: ipc.ipcMain, validateSender: () => true });
  assert.deepEqual(
    [...ipc.handlers.keys()].sort(),
    ["netcatty:ai:vendor:ask", "netcatty:ai:vendor:login", "netcatty:ai:vendor:status"],
  );
});

test("rejects calls from an unknown sender", async () => {
  const ipc = fakeIpc();
  registerVendorAssistantHandlers({ ipcMain: ipc.ipcMain, validateSenderOrSettings: () => false });
  const result = await ipc.handlers.get("netcatty:ai:vendor:status")({});
  assert.equal(result.ok, false);
  assert.match(String(result.error), /Unauthorized/);
});

test("the settings window guard is preferred over the main-window guard", async () => {
  const ipc = fakeIpc();
  const calls = [];
  registerVendorAssistantHandlers({
    ipcMain: ipc.ipcMain,
    // Main-window-only guard would reject the settings window.
    validateSender: () => false,
    validateSenderOrSettings: (event) => {
      calls.push(event);
      return true;
    },
  });
  const result = await ipc.handlers.get("netcatty:ai:vendor:status")({ sender: "settings" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ sender: "settings" }]);
});

test("status reports every vendor with a login state", async () => {
  const ipc = fakeIpc();
  registerVendorAssistantHandlers({ ipcMain: ipc.ipcMain, validateSender: () => true });
  const result = await ipc.handlers.get("netcatty:ai:vendor:status")({});
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.vendors));
  assert.equal(result.vendors.length, 6);
  for (const vendor of result.vendors) {
    assert.ok(typeof vendor.key === "string" && vendor.key);
    assert.ok(["logged", "unknown", "missing"].includes(vendor.login), vendor.login);
  }
});

test("ask rejects an empty question before launching a browser", async () => {
  const ipc = fakeIpc();
  registerVendorAssistantHandlers({ ipcMain: ipc.ipcMain, validateSender: () => true });
  const result = await ipc.handlers.get("netcatty:ai:vendor:ask")({}, { vendor: "ruijie", question: "  " });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /question/i);
});

test("ask rejects an unknown vendor", async () => {
  const ipc = fakeIpc();
  registerVendorAssistantHandlers({ ipcMain: ipc.ipcMain, validateSender: () => true });
  const result = await ipc.handlers.get("netcatty:ai:vendor:ask")({}, { vendor: "nope", question: "hello" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /vendor/i);
});
