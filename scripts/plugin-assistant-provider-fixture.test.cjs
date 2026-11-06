"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

test("deterministic native fixture streams synthetic text, rejects tools, and records cancellation without content logs", async (t) => {
  const { createAssistantProviderFixture } = await import("./plugin-assistant-provider-fixture.mjs");
  const { server, counts } = createAssistantProviderFixture({ delayMs: 10 });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const body = { model: "deterministic-fixture", stream: true, max_tokens: 100, messages: [{ role: "user", content: "Synthetic" }] };
  const request = (payload, signal) => fetch(`${endpoint}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
  const response = await request(body);
  const text = await response.text(); assert.match(text, /Synthetic plan/); assert.match(text, /total_tokens/);
  assert.equal(counts.completed, 1);
  assert.equal((await request({ ...body, tools: [{}] })).status, 400);
  assert.equal((await request({ ...body, messages: [{ role: "system", content: "Forbidden" }] })).status, 400);
  const controller = new AbortController(); const pending = await request(body, controller.signal);
  const reader = pending.body.getReader(); await reader.read(); controller.abort();
  for (let attempts = 0; counts.aborted === 0 && attempts < 50; attempts++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(counts.aborted, 1);
  const status = await (await fetch(`${endpoint}/fixture/status`)).json();
  assert.deepEqual(status, { fixture: true, inference: false, requests: 2, completed: 1, aborted: 1 });
});
