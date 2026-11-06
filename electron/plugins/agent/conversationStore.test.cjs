"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PluginAgentConversationStore } = require("./conversationStore.cjs");

const owner = (source) => ({ privateOwner: `opaque:${source}:same-plugin-id`, sourceKey: `source:${source}` });
const current = async () => {};
function record() {
  const conversationRef = randomUUID();
  return { conversationRef, id: `plugin-agent:${randomUUID()}`, title: "Synthetic chat", agentId: "catty",
    scope: { type: "global" }, messages: [{ id: randomUUID(), role: "user", content: "Synthetic only", timestamp: 1 }], createdAt: 1, updatedAt: 1 };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-agent-history-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new PluginAgentConversationStore(path.join(root, "core-history")) };
}

test("core history survives reopening, uses existing AISession shape and isolates the same plugin ID across sources", async (t) => {
  const { root, store } = await fixture(t); const chat = record();
  await store.save(owner("a"), chat, current);
  assert.deepEqual(await store.read(owner("a"), chat.conversationRef, current), chat);
  const [directory] = await fs.readdir(path.join(root, "core-history"));
  assert.doesNotMatch(directory, /opaque|same-plugin/);
  const mode = (await fs.stat(path.join(root, "core-history", directory, `${chat.conversationRef}.json`))).mode;
  if (process.platform !== "win32") assert.equal(mode & 0o777, 0o600);
  assert.equal(await store.read(owner("b"), chat.conversationRef, current), null);
  assert.deepEqual(await store.list(owner("b"), current), []);
  const reopened = new PluginAgentConversationStore(path.join(root, "core-history"));
  assert.deepEqual(await reopened.list(owner("a"), current), [chat]);
});

test("source revoked before async rename leaves previous history intact and cleans temporary files", async (t) => {
  const { store, root } = await fixture(t); const chat = record(); await store.save(owner("a"), chat, current);
  const next = { ...chat, title: "Must not commit" }; let checks = 0;
  await assert.rejects(store.save(owner("a"), next, async () => { if (++checks === 2) throw Error("Revoked"); }));
  assert.equal((await store.read(owner("a"), chat.conversationRef, current)).title, chat.title);
  const [directory] = await fs.readdir(path.join(root, "core-history"));
  assert.deepEqual(await fs.readdir(path.join(root, "core-history", directory)), [`${chat.conversationRef}.json`]);
});

test("history snapshots cannot mutate across await, and traversal/builtin IDs/oversized records are rejected", async (t) => {
  const { store } = await fixture(t); const chat = record(); const savedTitle = chat.title;
  const saved = store.save(owner("a"), chat, current); chat.title = "Changed after call"; await saved;
  assert.equal((await store.read(owner("a"), chat.conversationRef, current)).title, savedTitle);
  for (const id of ["../outside", "builtin-chat", "source:owner", ""]) await assert.rejects(store.read(owner("a"), id, current));
  await assert.rejects(store.save({ privateOwner: "bare-plugin" }, record(), current));
  await assert.rejects(store.save(owner("a"), { ...record(), id: "builtin-chat" }, current));
  await assert.rejects(store.save(owner("a"), { ...record(), scope: { type: "workspace", targetId: "active" } }, current));
  await assert.rejects(store.save(owner("a"), { ...record(), messages: Array(201).fill({}) }, current));
  await assert.rejects(store.save(owner("a"), { ...record(), messages: [{ content: "x".repeat(1_048_576) }] }, current));
});

test("symlinked history roots and files do not become history authority", async (t) => {
  const { root, store } = await fixture(t); const chat = record(); await store.save(owner("a"), chat, current);
  const history = path.join(root, "core-history"); const [directory] = await fs.readdir(history);
  const filename = path.join(history, directory, `${chat.conversationRef}.json`);
  const unrelated = path.join(root, "unrelated.json"); await fs.writeFile(unrelated, JSON.stringify(chat));
  await fs.rm(filename); await fs.symlink(unrelated, filename);
  await assert.rejects(store.read(owner("a"), chat.conversationRef, current));
  const linked = path.join(root, "linked"); await fs.symlink(history, linked, "dir");
  await assert.rejects(new PluginAgentConversationStore(linked).list(owner("a"), current));
});
