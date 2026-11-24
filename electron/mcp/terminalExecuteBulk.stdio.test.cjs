"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

/** Fake Netcatty bridge speaking newline-delimited JSON-RPC, like the real TCP host. */
async function startFakeBridge(handler) {
  const calls = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const { id, method, params } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        calls.push({ method, params });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: handler(method, params) })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connect(bridge, discoveryExtra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-bulk-wire-"));
  const discovery = path.join(tmp, "discovery.json");
  fs.writeFileSync(discovery, JSON.stringify({ port: bridge.port, token: "synthetic-test-auth", ...discoveryExtra }));
  const client = new Client({ name: "bulk-wire-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "netcatty-external-mcp-server.cjs")],
    env: { ...process.env, NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: discovery },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, cleanup: () => { fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const bulkPayload = {
  ok: true,
  hostCount: 3,
  counts: { completed: 3 },
  groups: [
    { hosts: [{ sessionId: "s1", label: "web1" }, { sessionId: "s2", label: "web2" }], status: "completed", exitCode: 0, stdout: "active" },
    { hosts: [{ sessionId: "s3", label: "web3" }], status: "completed", exitCode: 3, stdout: "inactive" },
  ],
};

test("terminal_execute_bulk is hidden until its toolset is loaded, then works over the real MCP wire", async () => {
  const bridge = await startFakeBridge((method) => (method === "netcatty/execBulk" ? bulkPayload : { ok: true }));
  const { client, cleanup } = await connect(bridge);
  try {
    const before = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(before.includes("terminal_execute_bulk"), false, "not in the initial tool list");
    assert.ok(before.includes("load_netcatty_tools"));

    const loader = (await client.listTools()).tools.find((tool) => tool.name === "load_netcatty_tools");
    assert.match(loader.description, /terminal_bulk/);

    const loaded = JSON.parse((await client.callTool({ name: "load_netcatty_tools", arguments: { toolset: "terminal_bulk" } })).content[0].text);
    assert.deepEqual(loaded.newlyLoaded, ["terminal_execute_bulk"]);

    const tool = (await client.listTools()).tools.find((entry) => entry.name === "terminal_execute_bulk");
    assert.ok(tool, "visible after loading");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["command", "sessionIds", "tailLines"]);
    assert.deepEqual([...tool.inputSchema.required].sort(), ["command", "sessionIds"]);
    assert.equal(tool.inputSchema.properties.sessionIds.type, "string");
    assert.equal(tool.inputSchema.properties.tailLines.type, "integer");

    const result = await client.callTool({
      name: "terminal_execute_bulk",
      arguments: { command: "systemctl is-active nginx", sessionIds: '["s1","s2","s3"]', tailLines: 20 },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), bulkPayload);

    const call = bridge.calls.find((entry) => entry.method === "netcatty/execBulk");
    assert.equal(call.params.command, "systemctl is-active nginx");
    assert.equal(call.params.sessionIds, '["s1","s2","s3"]');
    assert.equal(call.params.tailLines, 20);
    assert.ok(call.params.chatSessionId, "scoped to the external chat session");
  } finally {
    await client.close();
    cleanup();
    await bridge.close();
  }
});

test("a whole-call failure reaches the client as an Error text with isError", async () => {
  const error = [
    "nothing was sent. 1 of 2 targets cannot run this command:",
    '- ghost: Session "ghost" is not in the current scope.',
    "Remove or fix these session ids and retry.",
  ].join("\n");
  const bridge = await startFakeBridge((method) => (method === "netcatty/execBulk" ? { ok: false, code: "BULK_PREFLIGHT_FAILED", error } : { ok: true }));
  const { client, cleanup } = await connect(bridge);
  try {
    await client.callTool({ name: "load_netcatty_tools", arguments: { toolset: "terminal_bulk" } });
    const result = await client.callTool({ name: "terminal_execute_bulk", arguments: { command: "uptime", sessionIds: '["s1","ghost"]' } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `Error: ${error}`);
  } finally {
    await client.close();
    cleanup();
    await bridge.close();
  }
});

test("a native JSON array for sessionIds is rejected by the schema before it reaches Netcatty", async () => {
  const bridge = await startFakeBridge(() => ({ ok: true }));
  const { client, cleanup } = await connect(bridge);
  try {
    await client.callTool({ name: "load_netcatty_tools", arguments: { toolset: "terminal_bulk" } });
    const before = bridge.calls.length;
    const outcome = await client.callTool({ name: "terminal_execute_bulk", arguments: { command: "uptime", sessionIds: ["s1", "s2"] } })
      .then((value) => ({ value }), (error) => ({ error }));
    const text = outcome.error ? String(outcome.error.message) : JSON.stringify(outcome.value);
    assert.match(text, /sessionIds/);
    assert.match(text, /string/i);
    assert.equal(bridge.calls.length, before, "nothing was forwarded");
  } finally {
    await client.close();
    cleanup();
    await bridge.close();
  }
});

test("privacy masking covers the grouped result and restores tokens in the command", async () => {
  const bridge = await startFakeBridge((method, params) => {
    if (method !== "netcatty/execBulk") return { ok: true };
    return {
      ok: true,
      hostCount: 2,
      counts: { completed: 2 },
      groups: [
        { hosts: [{ sessionId: "s1", label: "198.51.100.7" }], status: "completed", exitCode: 0, stdout: "addr=192.0.2.10", stderr: "bad 192.0.2.10" },
        { hosts: [{ sessionId: "s2", label: "db" }], status: "completed", exitCode: 1, stdout: "addr=203.0.113.9", error: "" },
      ],
      echoedCommand: params.command,
    };
  });
  const { client, cleanup } = await connect(bridge, { redaction: { enabled: true } });
  try {
    await client.callTool({ name: "load_netcatty_tools", arguments: { toolset: "terminal_bulk" } });
    const result = await client.callTool({ name: "terminal_execute_bulk", arguments: { command: "echo hi", sessionIds: '["s1","s2"]' } });
    const text = result.content[0].text;
    assert.doesNotMatch(text, /192\.0\.2\.10|198\.51\.100\.7|203\.0\.113\.9/, "no raw addresses reach the model");
    const payload = JSON.parse(text);
    assert.equal(payload.groups[0].stdout.includes("NC_"), true);
    // The same address maps to the same token in stdout and stderr of one group.
    const token = payload.groups[0].stdout.match(/\[NC_[^\]]+\]/)[0];
    assert.ok(payload.groups[0].stderr.includes(token));

    // A token the model got back is restored before the command is policy-checked and run.
    await client.callTool({ name: "terminal_execute_bulk", arguments: { command: `ping ${token}`, sessionIds: '["s1","s2"]' } });
    const last = bridge.calls.filter((entry) => entry.method === "netcatty/execBulk").at(-1);
    assert.equal(last.params.command, "ping 192.0.2.10");
  } finally {
    await client.close();
    cleanup();
    await bridge.close();
  }
});
