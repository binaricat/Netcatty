"use strict";
/* global setImmediate */
const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture() {
  const commands = new Map(); const active = new Set(); const calls = []; let sequence = 0; let failure; let start = async () => {};
  const plugin = (await import("./src/index.js")).default;
  plugin.activate({ subscriptions: { add() {} }, commands: { registerCommand: (id, handler) => {
    commands.set(id.split(".").at(-1), handler); return { dispose() {} };
  } }, agent: {
    openChat: async () => { await start(); const chatHandle = `owned-${++sequence}`; calls.push(["open", chatHandle]); active.add(chatHandle); return { chatHandle }; },
    closeChat: async ({ chatHandle }) => {
      calls.push(["close", chatHandle]);
      if (failure) throw Object.assign(Error("Synthetic host error"), { code: failure });
      if (!active.delete(chatHandle)) throw Object.assign(Error("Unavailable owned handle"), { code: "permission_denied" });
      return { ok: true };
    },
  } });
  return { call: (name, params) => commands.get(name)(params), active, calls,
    failClose: (code) => { failure = code; }, delayOpen: (fn) => { start = fn; } };
}

test("sample serializes modal replacement and a stale Close cannot forget the replacement lease", async () => {
  const f = await fixture(); let resume; f.delayOpen(() => new Promise((resolve) => { resume = resolve; }));
  const first = f.call("open");
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  const second = f.call("open"); f.delayOpen(async () => {}); resume();
  const a = await first; const b = await second;
  assert.deepEqual(f.calls, [["open", a.chatHandle], ["close", a.chatHandle], ["open", b.chatHandle]]);
  await assert.rejects(f.call("close", { chatHandle: a.chatHandle }), { code: "permission_denied" });
  const c = await f.call("open");
  assert.deepEqual([...f.active], [c.chatHandle]);
  assert.deepEqual(f.calls.slice(-2), [["close", b.chatHandle], ["open", c.chatHandle]]);
});

test("sample recovers revoked owned leases but preserves unknown cleanup failures and activation isolation", async () => {
  const f = await fixture(); const a = await f.call("open"); f.active.clear();
  const b = await f.call("open"); assert.notEqual(b.chatHandle, a.chatHandle);
  f.failClose("unavailable"); const before = f.calls.length;
  await assert.rejects(f.call("open"), { code: "unavailable" });
  assert.deepEqual(f.calls.slice(before), [["close", b.chatHandle]], "no replacement Open after an uncertain cleanup failure");
  const other = await fixture(); await other.call("open"); assert.deepEqual(other.calls, [["open", "owned-1"]]);
  assert.deepEqual([...f.active], [b.chatHandle], "another activation cannot share the remembered lease");
  f.failClose(undefined); const c = await f.call("open"); assert.deepEqual([...f.active], [c.chatHandle]);
});
