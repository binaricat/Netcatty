const test = require("node:test");
const assert = require("node:assert/strict");

const { createPublicSessionRegistry } = require("./sessionRegistry.cjs");
const { createPublicRpcHandlers } = require("./rpcHandlers.cjs");

function makeWritableStream() {
  return {
    write() {
      return true;
    },
  };
}

function makeSession(overrides = {}) {
  return {
    hostname: "example.com",
    username: "root",
    label: "prod",
    shellKind: "bash",
    conn: { exec() {} },
    stream: makeWritableStream(),
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  const sessions = new Map([
    ["ssh-1", makeSession()],
    ["local-1", makeSession({ protocol: "local" })],
  ]);
  const registry = createPublicSessionRegistry({ sessions });
  const terminalCalls = [];
  const sftpCalls = [];

  const ctx = {
    registry,
    getCommandTimeoutMs() {
      return 60000;
    },
    getEnabled() {
      return true;
    },
    getPermissionMode() {
      return "autonomous";
    },
    getApprovalTimeoutMs() {
      return 110000;
    },
    async requestApproval() {
      return true;
    },
    terminalHandlers: {
      async handleTerminalExecute(params) {
        terminalCalls.push({ method: "execute", params });
        return { ok: true, command: params.command, sessionId: params.sessionId };
      },
      async handleTerminalStart(params) {
        terminalCalls.push({ method: "start", params });
        return { ok: true, jobId: "job-1", sessionId: params.sessionId, command: params.command };
      },
      handleTerminalPoll(params) {
        terminalCalls.push({ method: "poll", params });
        return { ok: true, jobId: params.jobId, output: "hello", nextOffset: 5 };
      },
      handleTerminalStop(params) {
        terminalCalls.push({ method: "stop", params });
        return { ok: true, jobId: params.jobId, status: "stopping" };
      },
    },
    sftpHandlers: {
      async handleSftpList(params) {
        sftpCalls.push({ method: "list", params });
        return { ok: true, entries: [{ filename: "hosts" }] };
      },
      async handleSftpReadFile(params) {
        sftpCalls.push({ method: "readFile", params });
        return { ok: true, path: params.path, content: "hello" };
      },
      async handleSftpWriteFile(params) {
        sftpCalls.push({ method: "writeFile", params });
        return { ok: true, path: params.path };
      },
      async handleSftpStat(params) {
        sftpCalls.push({ method: "stat", params });
        return { ok: true, stat: { size: 5 } };
      },
      async handleSftpHome(params) {
        sftpCalls.push({ method: "home", params });
        return { ok: true, homeDir: "/root" };
      },
      async handleSftpMkdir(params) {
        sftpCalls.push({ method: "mkdir", params });
        return { ok: true, path: params.path };
      },
      async handleSftpDelete(params) {
        sftpCalls.push({ method: "delete", params });
        return { ok: true, path: params.path };
      },
      async handleSftpRename(params) {
        sftpCalls.push({ method: "rename", params });
        return { ok: true, oldPath: params.oldPath, newPath: params.newPath };
      },
      async handleSftpChmod(params) {
        sftpCalls.push({ method: "chmod", params });
        return { ok: true, path: params.path, mode: params.mode };
      },
    },
    ...overrides,
  };

  return {
    ctx,
    sessions,
    terminalCalls,
    sftpCalls,
  };
}

test("rpc handlers return live public environment and current bridge status", async () => {
  const { ctx, sessions } = makeContext();
  const handlers = createPublicRpcHandlers(ctx);

  const firstEnvironment = await handlers.dispatch("public/getEnvironment", {});
  const firstStatus = await handlers.dispatch("public/getStatus", {});

  assert.equal(firstEnvironment.ok, true);
  assert.equal(firstEnvironment.environment, "netcatty-public-mcp");
  assert.equal(firstEnvironment.hostCount, 1);
  assert.equal(firstEnvironment.hosts.length, 1);
  assert.equal(firstEnvironment.hosts[0].sessionId, "ssh-1");
  assert.deepEqual(firstStatus, {
    ok: true,
    enabled: true,
    available: true,
    commandTimeoutMs: 60000,
    permissionMode: "autonomous",
    approvalTimeoutMs: 110000,
    sessionCount: 1,
  });

  sessions.set("ssh-2", makeSession({ hostname: "db.example.com", label: "db" }));

  const secondEnvironment = await handlers.dispatch("public/getEnvironment", {});
  const secondStatus = await handlers.dispatch("public/getStatus", {});

  assert.equal(secondEnvironment.hostCount, 2);
  assert.deepEqual(
    secondEnvironment.hosts.map((host) => host.sessionId),
    ["ssh-1", "ssh-2"],
  );
  assert.equal(secondStatus.sessionCount, 2);
});

test("rpc handlers dispatch terminal methods to terminal handlers", async () => {
  const { ctx, terminalCalls } = makeContext();
  const handlers = createPublicRpcHandlers(ctx);

  const executeResult = await handlers.dispatch("public/terminalExecute", {
    sessionId: "ssh-1",
    command: "pwd",
  });
  const startResult = await handlers.dispatch("public/terminalStart", {
    sessionId: "ssh-1",
    command: "npm run build",
  });
  const pollResult = await handlers.dispatch("public/terminalPoll", {
    jobId: "job-1",
    offset: 0,
  });
  const stopResult = await handlers.dispatch("public/terminalStop", {
    jobId: "job-1",
  });

  assert.deepEqual(executeResult, { ok: true, command: "pwd", sessionId: "ssh-1" });
  assert.deepEqual(startResult, { ok: true, jobId: "job-1", sessionId: "ssh-1", command: "npm run build" });
  assert.deepEqual(pollResult, { ok: true, jobId: "job-1", output: "hello", nextOffset: 5 });
  assert.deepEqual(stopResult, { ok: true, jobId: "job-1", status: "stopping" });
  assert.deepEqual(
    terminalCalls.map((entry) => entry.method),
    ["execute", "start", "poll", "stop"],
  );
});

test("rpc handlers dispatch sftp methods to sftp handlers", async () => {
  const { ctx, sftpCalls } = makeContext();
  const handlers = createPublicRpcHandlers(ctx);

  const listResult = await handlers.dispatch("public/sftp/list", { sessionId: "ssh-1", path: "/etc" });
  const readResult = await handlers.dispatch("public/sftp/readFile", { sessionId: "ssh-1", path: "/etc/hosts" });
  const writeResult = await handlers.dispatch("public/sftp/writeFile", { sessionId: "ssh-1", path: "/tmp/demo.txt", content: "hi" });
  const statResult = await handlers.dispatch("public/sftp/stat", { sessionId: "ssh-1", path: "/etc/hosts" });
  const homeResult = await handlers.dispatch("public/sftp/home", { sessionId: "ssh-1" });
  const mkdirResult = await handlers.dispatch("public/sftp/mkdir", { sessionId: "ssh-1", path: "/tmp/demo" });
  const deleteResult = await handlers.dispatch("public/sftp/delete", { sessionId: "ssh-1", path: "/tmp/demo.txt" });
  const renameResult = await handlers.dispatch("public/sftp/rename", { sessionId: "ssh-1", oldPath: "/tmp/a", newPath: "/tmp/b" });
  const chmodResult = await handlers.dispatch("public/sftp/chmod", { sessionId: "ssh-1", path: "/tmp/demo.txt", mode: "0644" });

  assert.deepEqual(listResult, { ok: true, entries: [{ filename: "hosts" }] });
  assert.deepEqual(readResult, { ok: true, path: "/etc/hosts", content: "hello" });
  assert.deepEqual(writeResult, { ok: true, path: "/tmp/demo.txt" });
  assert.deepEqual(statResult, { ok: true, stat: { size: 5 } });
  assert.deepEqual(homeResult, { ok: true, homeDir: "/root" });
  assert.deepEqual(mkdirResult, { ok: true, path: "/tmp/demo" });
  assert.deepEqual(deleteResult, { ok: true, path: "/tmp/demo.txt" });
  assert.deepEqual(renameResult, { ok: true, oldPath: "/tmp/a", newPath: "/tmp/b" });
  assert.deepEqual(chmodResult, { ok: true, path: "/tmp/demo.txt", mode: "0644" });
  assert.deepEqual(
    sftpCalls.map((entry) => entry.method),
    ["list", "readFile", "writeFile", "stat", "home", "mkdir", "delete", "rename", "chmod"],
  );
});

test("rpc handlers enforce observer permission mode for public write methods", async () => {
  const { ctx, terminalCalls, sftpCalls } = makeContext({
    getPermissionMode() {
      return "observer";
    },
  });
  const handlers = createPublicRpcHandlers(ctx);

  const executeResult = await handlers.dispatch("public/terminalExecute", {
    sessionId: "ssh-1",
    command: "pwd",
  });
  const readResult = await handlers.dispatch("public/sftp/readFile", {
    sessionId: "ssh-1",
    path: "/etc/hosts",
  });
  const writeResult = await handlers.dispatch("public/sftp/writeFile", {
    sessionId: "ssh-1",
    path: "/tmp/demo.txt",
    content: "hi",
  });

  assert.equal(executeResult.ok, false);
  assert.match(executeResult.error, /observer/);
  assert.deepEqual(readResult, { ok: true, path: "/etc/hosts", content: "hello" });
  assert.equal(writeResult.ok, false);
  assert.match(writeResult.error, /observer/);
  assert.deepEqual(terminalCalls, []);
  assert.deepEqual(
    sftpCalls.map((entry) => entry.method),
    ["readFile"],
  );
});

test("rpc handlers request approval for public write methods in confirm mode", async () => {
  const approvalRequests = [];
  const { ctx, terminalCalls, sftpCalls } = makeContext({
    getPermissionMode() {
      return "confirm";
    },
    async requestApproval(payload) {
      approvalRequests.push(payload);
      return payload.method === "public/terminalExecute";
    },
  });
  const handlers = createPublicRpcHandlers(ctx);

  const executeResult = await handlers.dispatch("public/terminalExecute", {
    sessionId: "ssh-1",
    command: "pwd",
  });
  const writeResult = await handlers.dispatch("public/sftp/writeFile", {
    sessionId: "ssh-1",
    path: "/tmp/demo.txt",
    content: "hi",
  });

  assert.deepEqual(executeResult, { ok: true, command: "pwd", sessionId: "ssh-1" });
  assert.equal(writeResult.ok, false);
  assert.match(writeResult.error, /denied by user/);
  assert.deepEqual(
    approvalRequests.map((request) => request.method),
    ["public/terminalExecute", "public/sftp/writeFile"],
  );
  assert.deepEqual(terminalCalls.map((entry) => entry.method), ["execute"]);
  assert.deepEqual(sftpCalls, []);
});

test("rpc handlers do not request approval for public write methods in autonomous mode", async () => {
  let approvalCount = 0;
  const { ctx, terminalCalls } = makeContext({
    getPermissionMode() {
      return "autonomous";
    },
    async requestApproval() {
      approvalCount += 1;
      return false;
    },
  });
  const handlers = createPublicRpcHandlers(ctx);

  const result = await handlers.dispatch("public/terminalExecute", {
    sessionId: "ssh-1",
    command: "pwd",
  });

  assert.deepEqual(result, { ok: true, command: "pwd", sessionId: "ssh-1" });
  assert.equal(approvalCount, 0);
  assert.deepEqual(terminalCalls.map((entry) => entry.method), ["execute"]);
});

test("rpc handlers dispatch public asset methods through capability dispatcher", async () => {
  const capabilityCalls = [];
  const { ctx } = makeContext({
    async dispatchCapabilityRpc(method, params) {
      capabilityCalls.push({ method, params });
      return { ok: true, method, hostId: params.hostId };
    },
  });
  const handlers = createPublicRpcHandlers(ctx);

  const result = await handlers.dispatch("public/asset/connect", {
    hostId: "host-1",
  });

  assert.deepEqual(result, {
    ok: true,
    method: "public/asset/connect",
    hostId: "host-1",
  });
  assert.deepEqual(capabilityCalls, [
    { method: "public/asset/connect", params: { hostId: "host-1" } },
  ]);
});

test("rpc handlers reject unknown methods", async () => {
  const { ctx } = makeContext();
  const handlers = createPublicRpcHandlers(ctx);

  await assert.rejects(
    handlers.dispatch("public/unknown", {}),
    /Unknown method/,
  );
});
