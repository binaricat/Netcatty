"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BUILTIN_WRITE_RPC_METHODS,
  BUILTIN_APPROVAL_RPC_METHODS,
  PUBLIC_CONFIRM_RPC_METHODS,
  evaluateRpcPermission,
  evaluatePermissionWithGrants,
  OBSERVER_DENY_MESSAGE,
} = require("./policy.cjs");
const { CAPABILITY_SURFACES, PERMISSION_MODES } = require("./constants.cjs");

test("builtin write methods match legacy mcpServerBridge write set", () => {
  const legacyWriteMethods = [
    "netcatty/exec",
    "netcatty/sftp/write",
    "netcatty/sftp/download",
    "netcatty/sftp/upload",
    "netcatty/sftp/mkdir",
    "netcatty/sftp/delete",
    "netcatty/sftp/rename",
    "netcatty/sftp/chmod",
    "netcatty/jobStart",
    "netcatty/jobStop",
  ];
  assert.deepEqual(new Set(legacyWriteMethods), BUILTIN_WRITE_RPC_METHODS);
});

test("builtin approval methods exclude jobStop and non-write control rpc", () => {
  assert.equal(BUILTIN_APPROVAL_RPC_METHODS.has("netcatty/jobStop"), false);
  assert.equal(BUILTIN_APPROVAL_RPC_METHODS.has("netcatty/setCancelled"), false);
  assert.equal(BUILTIN_APPROVAL_RPC_METHODS.has("netcatty/exec"), true);
  assert.equal(BUILTIN_APPROVAL_RPC_METHODS.has("netcatty/sftp/write"), true);
});

test("observer mode blocks writes but allows terminal poll", () => {
  const denied = evaluateRpcPermission({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.OBSERVER,
    params: { chatSessionId: "chat-1" },
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.error, /observer/i);

  const allowed = evaluateRpcPermission({
    rpcMethod: "netcatty/jobPoll",
    permissionMode: PERMISSION_MODES.OBSERVER,
    params: { chatSessionId: "chat-1" },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.requiresApproval, false);
});

test("confirm mode requires approval for writes but not sftp list on builtin surface", () => {
  const writeDecision = evaluateRpcPermission({
    rpcMethod: "netcatty/sftp/write",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { chatSessionId: "chat-1" },
  });
  assert.equal(writeDecision.allowed, true);
  assert.equal(writeDecision.requiresApproval, true);

  const readDecision = evaluateRpcPermission({
    rpcMethod: "netcatty/sftp/list",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { chatSessionId: "chat-1" },
  });
  assert.equal(readDecision.allowed, true);
  assert.equal(readDecision.requiresApproval, false);
});

test("public surface treats sensitive reads as confirm-gated", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "public/sftp/list",
    surface: CAPABILITY_SURFACES.PUBLIC,
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { sessionId: "sess-1" },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.equal(PUBLIC_CONFIRM_RPC_METHODS.has("public/sftp/list"), true);
});

test("write operations require chatSessionId on builtin surface", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.AUTO,
    params: {},
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.error, /chatSessionId/i);
});

test("cancelled chat sessions block terminal writes", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.AUTO,
    params: { chatSessionId: "chat-1" },
    context: { chatSessionCancelled: true },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.error, /cancelled/i);
});

test("cancelled chat sessions block sftp writes", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "netcatty/sftp/write",
    permissionMode: PERMISSION_MODES.AUTO,
    params: { chatSessionId: "chat-1" },
    context: { chatSessionCancelled: true },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.error, /cancelled/i);
});

test("cancelled chat sessions still allow sftp reads", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "netcatty/sftp/list",
    permissionMode: PERMISSION_MODES.AUTO,
    params: { chatSessionId: "chat-1" },
    context: { chatSessionCancelled: true },
  });
  assert.equal(decision.allowed, true);
});

test("jobStop bypasses observer and cancelled chat checks", () => {
  const observerDecision = evaluateRpcPermission({
    rpcMethod: "netcatty/jobStop",
    permissionMode: PERMISSION_MODES.OBSERVER,
    params: { chatSessionId: "chat-1" },
    context: { chatSessionCancelled: true },
  });
  assert.equal(observerDecision.allowed, true);
  assert.notEqual(observerDecision.error, OBSERVER_DENY_MESSAGE);
});

test("unknown rpc methods pass through policy checks", () => {
  const decision = evaluateRpcPermission({
    rpcMethod: "auth/verify",
    permissionMode: PERMISSION_MODES.OBSERVER,
    params: {},
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.capability, null);
});

test("confirm mode requires approval for portforward start and host notes set", () => {
  const portforwardDecision = evaluateRpcPermission({
    rpcMethod: "public/portforward/start",
    surface: CAPABILITY_SURFACES.PUBLIC,
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { chatSessionId: "chat-1", ruleId: "rule-1" },
  });
  assert.equal(portforwardDecision.requiresApproval, true);

  const notesDecision = evaluateRpcPermission({
    rpcMethod: "vault/host/notes/set",
    surface: CAPABILITY_SURFACES.GLOBAL,
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { chatSessionId: "chat-1", hostId: "host-1" },
  });
  assert.equal(notesDecision.requiresApproval, true);

  const publicNotesDecision = evaluateRpcPermission({
    rpcMethod: "public/vault/hostNotes/set",
    surface: CAPABILITY_SURFACES.PUBLIC,
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: { chatSessionId: "chat-1", hostId: "host-1" },
  });
  assert.equal(publicNotesDecision.requiresApproval, true);
});

test("evaluatePermissionWithGrants skips approval when a grant matches", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: "ls -la",
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-1",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "ls *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);
});

test("evaluatePermissionWithGrants does not let a comment grant approve a multiline command", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "# 1a) clear the kernel_options_post profile field",
        "cobbler profile edit --name=openEuler-22.03-aarch64 --kernel-options-post=\"\"",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-comment",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "# *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let a here-doc body grant approve the command", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat <<'EOF'",
        "rm -rf /tmp/demo",
        "EOF",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-rm",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "rm *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let a piped here-doc body grant approve the command", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat <<EOF | grep needle",
        "rm -rf /tmp/demo",
        "EOF",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-rm",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "rm *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let an fd-prefixed here-doc body grant approve the command", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat 0<<EOF",
        "rm -rf /tmp/demo",
        "EOF",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-rm",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "rm *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let a background command grant approve the next command", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: "cd /tmp; sleep 1 & rm -rf demo",
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-sleep",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "sleep *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let cwd substitutions hide before a later grant", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: "cd \"$(pwd)\"; ls -la",
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-ls",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "ls *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let quoted here-doc operator text hide later commands", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cd /tmp; echo '<<EOF'",
        "rm -rf demo",
        "EOF",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-echo",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "echo *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants keeps commands after mixed-quoted here-doc delimiters grantable", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat <<E\"OF\"",
        "body text",
        "EOF",
        "ls -la",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-cat",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "cat *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants does not let arithmetic shifts hide following commands", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "ls $((1 << 2))",
        "rm -rf demo",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-ls",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "ls *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants keeps commands after ANSI-C quoted here-doc delimiters grantable", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat <<$'E\\x4fF'",
        "body text",
        "EOF",
        "rm -rf demo",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-cat",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "cat *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});

test("evaluatePermissionWithGrants keeps commands after dollar-quoted here-doc delimiters grantable", () => {
  const decision = evaluatePermissionWithGrants({
    rpcMethod: "netcatty/exec",
    permissionMode: PERMISSION_MODES.CONFIRM,
    params: {
      chatSessionId: "chat-1",
      sessionId: "session-a",
      command: [
        "cat <<$'EOF'",
        "body text",
        "EOF",
        "rm -rf demo",
      ].join("\n"),
    },
    context: { chatSessionCancelled: false },
  }, [{
    id: "grant-cat",
    capabilityId: "terminal.execute",
    sessionPattern: "session-a",
    commandPattern: "cat *",
    createdAt: Date.now(),
  }]);

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
});
