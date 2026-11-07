"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createDefinitionValidator } = require("../contractValidator.cjs");

test("Agent wire accepts only opaque host configuration/scope refs, never raw backend authority", () => {
  const open = createDefinitionValidator("PluginAgentOpenParams");
  const params = { backendRef: randomUUID(), selectionHandle: randomUUID() };
  assert.equal(open(params), true);
  for (const [key, value] of Object.entries({ permissionMode: "auto", owner: "source:forged", privateOwner: "forged",
    source: "official", model: "chosen", agentId: "claude", apiKey: "synthetic-not-a-key", cli: "node",
    env: {}, mcpServers: {}, sessionIds: ["focused-session"], externalSessionId: "native-session" })) {
    assert.equal(open({ ...params, [key]: value }), false, key);
  }
  for (const key of ["backendRef", "selectionHandle", "conversationRef"]) {
    assert.equal(open({ ...params, [key]: "internal-or-path-id" }), false, key);
  }
});

test("Agent messages and events are bounded and do not serialize raw tools/configuration", () => {
  const send = createDefinitionValidator("PluginAgentSendParams");
  const params = { chatHandle: randomUUID(), text: "Synthetic user instruction" };
  assert.equal(send(params), true);
  assert.equal(send({ ...params, text: "x".repeat(16_385) }), false);
  assert.equal(send({ ...params, text: "a\0b" }), false);
  assert.equal(send({ ...params, turnId: "builtin" }), false);
  const event = createDefinitionValidator("PluginAgentEvent");
  assert.equal(event({ kind: "activity", capabilityId: "terminal.execute", state: "started" }), true);
  assert.equal(event({ kind: "activity", capabilityId: "terminal.execute", state: "started", args: { command: "raw" } }), false);
  assert.equal(event({ kind: "usage", inputTokens: 2, outputTokens: 4 }), true);
  assert.equal(event({ kind: "usage", inputTokens: -1, outputTokens: 4 }), false);
  assert.equal(event({ kind: "text", text: "x".repeat(4097) }), false);
  assert.equal(event({ kind: "provider-error", message: "private diagnostics" }), false);
});

test("public chat/history summaries do not contain backend/native identifiers, prompts or tool results", () => {
  const chats = createDefinitionValidator("PluginAgentChatsResult");
  const chat = { conversationRef: randomUUID(), title: "Synthetic chat", backend: "claude", updatedAt: 1 };
  assert.equal(chats({ items: [chat] }), true);
  assert.equal(chats({ items: [{ ...chat, externalSessionId: "native" }] }), false);
  const history = createDefinitionValidator("PluginAgentHistoryResult");
  assert.equal(history({ items: [{ role: "assistant", text: "Summary" }] }), true);
  assert.equal(history({ items: [{ role: "tool", text: "Raw tool result" }] }), false);
  assert.equal(history({ items: [{ role: "assistant", text: "Summary", apiKey: "synthetic" }] }), false);
});
