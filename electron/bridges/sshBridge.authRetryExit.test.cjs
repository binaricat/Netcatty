const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

function makeSender(events = null) {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      events?.push(`send:${channel}`);
      this.sent.push({ channel, payload });
    },
  };
}

function makeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on() {},
  };
}

function createShellStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => true;
  stream.end = () => {};
  stream.destroy = () => {};
  stream.setWindow = () => {};
  return stream;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeReusableSourceSession(endpoint) {
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn._remoteVer = "OpenSSH_test";
  conn.shell = () => { throw new Error("Not connected"); };
  conn.end = () => {};
  conn.destroy = () => {};
  const stream = createShellStream();
  return {
    conn,
    stream,
    chainConnections: [],
    connRef: { count: 1, conn, chainConnections: [] },
    webContentsId: 1,
    zmodemSentry: { cancel() {} },
    hostname: endpoint.hostname,
    username: endpoint.username,
    _reuseEndpoint: {
      hostname: endpoint.hostname,
      port: endpoint.port || 22,
      username: endpoint.username,
    },
  };
}

function loadBridgeWithAuthRetryMocks(t, options = {}) {
  const bridgePath = require.resolve("./sshBridge.cjs");
  const startSessionPath = require.resolve("./sshBridge/startSession.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;
  const originalAuthHelper = require(authHelperPath);
  const connectEvents = options.connectEvents || ["auth-error", "ready"];

  class MockSSHClient extends EventEmitter {
    constructor() {
      super();
      MockSSHClient.instances.push(this);
      this._remoteVer = "OpenSSH_test";
      this._sock = {
        setTimeout() {},
        setNoDelay() {},
      };
    }

    connect(opts) {
      this.connectOpts = opts;
      const eventName = connectEvents[MockSSHClient.connectCount++] || "auth-error";
      setImmediate(() => {
        if (
          eventName === "repeated-keyboard-interactive" ||
          eventName === "excessive-keyboard-interactive" ||
          eventName === "password-and-keyboard-interactive" ||
          eventName === "password-then-keyboard-interactive" ||
          eventName === "mfa-keyboard-interactive-before-password" ||
          eventName === "agent-password-removes-keyboard-interactive" ||
          eventName === "agent-then-keyboard-interactive-after-skip-password" ||
          eventName === "publickey-then-password-and-keyboard-interactive" ||
          eventName === "agent-then-password-and-keyboard-interactive"
        ) {
          this.authMethodsOffered = [];
          this.keyboardInteractiveResponses = [];
          this.emit("connect");
          this.emit("handshake");

          const offerNext = (methodsLeft, partialSuccess) => {
            let offered;
            opts.authHandler(methodsLeft, partialSuccess, (method) => {
              offered = method;
              this.authMethodsOffered.push(method);
            });
            return offered;
          };

          offerNext(null, null);
          const firstMethods = eventName === "password-and-keyboard-interactive"
            ? ["publickey", "password", "keyboard-interactive"]
            : eventName === "password-then-keyboard-interactive"
              ? ["password"]
              : eventName === "mfa-keyboard-interactive-before-password"
                ? ["publickey", "password", "keyboard-interactive"]
                : eventName === "agent-password-removes-keyboard-interactive" ||
                    eventName === "agent-then-keyboard-interactive-after-skip-password"
                  ? ["publickey", "password", "keyboard-interactive"]
                  : eventName === "publickey-then-password-and-keyboard-interactive"
                    ? ["publickey"]
                    : eventName === "agent-then-password-and-keyboard-interactive"
                      ? ["agent"]
                      : ["keyboard-interactive"];
          const firstInteractive = offerNext(firstMethods, false);
          if (eventName === "agent-password-removes-keyboard-interactive") {
            if (firstInteractive !== "agent") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const password = offerNext(firstMethods, false);
            if (password !== "password") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            offerNext(["publickey"], false);
            const err = new Error("All configured authentication methods failed");
            err.level = "client-authentication";
            this.emit("error", err);
            return;
          }
          if (eventName === "agent-then-keyboard-interactive-after-skip-password") {
            if (firstInteractive !== "agent") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const firstKeyboardInteractive = offerNext(firstMethods, false);
            if (firstKeyboardInteractive !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            this.emit(
              "keyboard-interactive",
              "Login authentication",
              "",
              "",
              [{ prompt: "Password:", echo: false }],
              (responses) => {
                this.keyboardInteractiveResponses.push(responses);
                const secondKeyboardInteractive = offerNext(["keyboard-interactive"], true);
                if (secondKeyboardInteractive !== "keyboard-interactive") {
                  const err = new Error("All configured authentication methods failed");
                  err.level = "client-authentication";
                  this.emit("error", err);
                  return;
                }
                this.emit(
                  "keyboard-interactive",
                  "Keyboard-interactive authentication prompts from server",
                  "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
                  "",
                  [{ prompt: "Secondary Authentication Password:", echo: false }],
                  (secondResponses) => {
                    this.keyboardInteractiveResponses.push(secondResponses);
                    this.emit("ready");
                  },
                );
              },
            );
            return;
          }
          if (eventName === "mfa-keyboard-interactive-before-password") {
            if (opts._skipPasswordMethod) {
              if (firstInteractive !== "keyboard-interactive") {
                const err = new Error("All configured authentication methods failed");
                err.level = "client-authentication";
                this.emit("error", err);
                return;
              }
              this.emit(
                "keyboard-interactive",
                "Login authentication",
                "",
                "",
                [{ prompt: "Password:", echo: false }],
                (responses) => {
                  this.keyboardInteractiveResponses.push(responses);
                  const secondInteractive = offerNext(["keyboard-interactive"], true);
                  if (secondInteractive !== "keyboard-interactive") {
                    const err = new Error("All configured authentication methods failed");
                    err.level = "client-authentication";
                    this.emit("error", err);
                    return;
                  }
                  this.emit(
                    "keyboard-interactive",
                    "Keyboard-interactive authentication prompts from server",
                    "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
                    "",
                    [{ prompt: "Secondary Authentication Password:", echo: false }],
                    (secondResponses) => {
                      this.keyboardInteractiveResponses.push(secondResponses);
                      this.emit("ready");
                    },
                  );
                },
              );
              return;
            }
            if (firstInteractive?.type === "password") {
              // Mirrors the live EDR server: after a rejected password attempt,
              // keyboard-interactive disappears from methodsLeft.
              offerNext(["publickey"], false);
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            if (firstInteractive !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
          }
          if (eventName === "password-and-keyboard-interactive") {
            // Password-first: login password method, then KI for secondary factor.
            if (firstInteractive?.type !== "password") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const secondFactor = offerNext(["password", "keyboard-interactive"], true);
            if (secondFactor !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            this.emit(
              "keyboard-interactive",
              "Keyboard-interactive authentication prompts from server",
              "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
              "",
              [{ prompt: "Secondary Authentication Password:", echo: false }],
              (responses) => {
                this.keyboardInteractiveResponses.push(responses);
                this.emit("ready");
              },
            );
            return;
          }
          if (eventName === "publickey-then-password-and-keyboard-interactive") {
            if (firstInteractive?.type !== "publickey") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const secondFactor = offerNext(["password", "keyboard-interactive"], true);
            if (secondFactor !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            this.emit(
              "keyboard-interactive",
              "Keyboard-interactive authentication prompts from server",
              "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
              "",
              [{ prompt: "Secondary Authentication Password:", echo: false }],
              (responses) => {
                this.keyboardInteractiveResponses.push(responses);
                this.emit("ready");
              },
            );
            return;
          }
          if (eventName === "agent-then-password-and-keyboard-interactive") {
            if (firstInteractive !== "agent") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const secondFactor = offerNext(["password", "keyboard-interactive"], true);
            if (secondFactor !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            this.emit(
              "keyboard-interactive",
              "Keyboard-interactive authentication prompts from server",
              "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
              "",
              [{ prompt: "Secondary Authentication Password:", echo: false }],
              (responses) => {
                this.keyboardInteractiveResponses.push(responses);
                this.emit("ready");
              },
            );
            return;
          }
          if (eventName === "password-then-keyboard-interactive") {
            if (firstInteractive?.type !== "password") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            const fallbackInteractive = offerNext(["keyboard-interactive"], false);
            if (fallbackInteractive !== "keyboard-interactive") {
              const err = new Error("All configured authentication methods failed");
              err.level = "client-authentication";
              this.emit("error", err);
              return;
            }
            this.emit(
              "keyboard-interactive",
              "Keyboard-interactive authentication prompts from server",
              "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
              "",
              [{ prompt: "Secondary Authentication Password:", echo: false }],
              (responses) => {
                this.keyboardInteractiveResponses.push(responses);
                this.emit("ready");
              },
            );
            return;
          }
          if (firstInteractive !== "keyboard-interactive") {
            const err = new Error("All configured authentication methods failed");
            err.level = "client-authentication";
            this.emit("error", err);
            return;
          }

          this.emit(
            "keyboard-interactive",
            "Login authentication",
            "",
            "",
            [{ prompt: "Password:", echo: false }],
            (responses) => {
              this.keyboardInteractiveResponses.push(responses);
              const secondInteractive = offerNext(["keyboard-interactive"], true);
              if (secondInteractive !== "keyboard-interactive") {
                const err = new Error("All configured authentication methods failed");
                err.level = "client-authentication";
                this.emit("error", err);
                return;
              }

              this.emit(
                "keyboard-interactive",
                "Keyboard-interactive authentication prompts from server",
                "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
                "",
                [{ prompt: "Secondary Authentication Password:", echo: false }],
                (secondResponses) => {
                  this.keyboardInteractiveResponses.push(secondResponses);
                  if (eventName === "excessive-keyboard-interactive") {
                    const thirdInteractive = offerNext(["keyboard-interactive"], true);
                    const err = new Error(
                      thirdInteractive === false
                        ? "All configured authentication methods failed"
                        : "Repeated keyboard-interactive limit was not enforced",
                    );
                    err.level = "client-authentication";
                    this.emit("error", err);
                    return;
                  }
                  this.emit("ready");
                },
              );
            },
          );
          return;
        }
        if (eventName === "auth-error") {
          const err = new Error("All configured authentication methods failed");
          err.level = "client-authentication";
          this.emit("error", err);
          return;
        }
        if (eventName === "socket-error") {
          const err = new Error("Connection reset by auth-bastion.example.com");
          err.level = "client-socket";
          this.emit("error", err);
          return;
        }
        if (eventName === "permission-denied-socket-error") {
          const err = new Error("Permission denied opening channel to auth-bastion.example.com");
          err.level = "client-socket";
          this.emit("error", err);
          return;
        }
        if (eventName === "too-many-auth") {
          const err = new Error("Too many authentication failures");
          this.emit("error", err);
          return;
        }
        if (eventName === "ready") {
          this.emit("connect");
          this.emit("handshake");
          this.emit("ready");
        }
      });
    }

    forwardOut(_srcHost, _srcPort, _dstHost, _dstPort, cb) {
      setImmediate(() => cb(null, new EventEmitter()));
    }

    shell(_pty, shellOptions, cb) {
      this.shellOptions = shellOptions;
      setImmediate(() => cb(null, createShellStream()));
    }

    end() {
      this.ended = true;
    }

    destroy() {
      this.destroyed = true;
    }
  }
  MockSSHClient.instances = [];
  MockSSHClient.connectCount = 0;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockSSHClient,
        utils: { parseKey: () => options.parseKeyResult || new Error("no key parse needed") },
      };
    }
    if (request === "./netcattyAgent.cjs" || request.endsWith("/netcattyAgent.cjs")) {
      return { NetcattyAgent: class MockNetcattyAgent {} };
    }
    if (request === "./sshAuthHelper.cjs" || request.endsWith("/sshAuthHelper.cjs")) {
      return {
        ...originalAuthHelper,
        findAllDefaultPrivateKeys: async (args = {}) => {
          if (args.includeEncrypted) {
            return options.encryptedKeys || [];
          }
          return options.defaultKeys || [];
        },
        requestPassphrasesForEncryptedKeys: async () => (
          options.onPassphraseRequest?.(),
          options.passphraseResult || { cancelled: false, keys: [] }
        ),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  delete require.cache[startSessionPath];
  const bridge = require("./sshBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    delete require.cache[startSessionPath];
    Module._load = originalLoad;
  });

  return { bridge, MockSSHClient };
}

test("terminal SSH supports consecutive keyboard-interactive factors (#2150)", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["repeated-keyboard-interactive"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "repeated-ki-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "password",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "repeated-ki-session" });
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    ["none", "keyboard-interactive", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["login-password"], ["secondary-password"]],
  );
  const promptEvents = sender.sent.filter((message) => (
    message.channel === "netcatty:keyboard-interactive"
  ));
  assert.equal(promptEvents.length, 1);
  assert.equal(
    promptEvents[0].payload.prompts[0].prompt,
    "Secondary Authentication Password:",
  );
  assert.equal(
    promptEvents[0].payload.instructions,
    "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。",
  );
  assert.equal(promptEvents[0].payload.savedPassword, null);
  assert.equal(promptEvents[0].payload.allowSavePassword, false);
    assert.equal(promptEvents[0].payload.scope, "terminal");
});

test("terminal SSH retries keyboard-interactive first when password rejection removes KI", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["mfa-keyboard-interactive-before-password", "mfa-keyboard-interactive-before-password"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "mfa-ki-first-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "password",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "mfa-ki-first-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    [
      "none",
      { type: "password", username: "alice", password: "login-password" },
      false,
    ],
  );
  assert.deepEqual(
    MockSSHClient.instances[1].authMethodsOffered,
    ["none", "keyboard-interactive", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[1].keyboardInteractiveResponses,
    [["login-password"], ["secondary-password"]],
  );
});

test("failed keyboard-interactive retry still offers encrypted default key fallback", async (t) => {
  const events = [];
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["mfa-keyboard-interactive-before-password", "auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
    onPassphraseRequest: () => events.push("passphrase-request"),
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender(events);

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "mfa-ki-encrypted-fallback-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "auto",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "mfa-ki-encrypted-fallback-session" });
  assert.equal(MockSSHClient.instances.length, 3);
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    [
      "none",
      { type: "password", username: "alice", password: "login-password" },
      false,
    ],
  );
  assert.equal(events.includes("passphrase-request"), true);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "mfa-ki-encrypted-fallback-session"
    )),
    false,
  );
});

test("terminal SSH password-first then keyboard-interactive when both methods are advertised", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["password-and-keyboard-interactive"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "password-or-ki-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "password",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "password-or-ki-session" });
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered.map((method) => (
      method && typeof method === "object" ? method.type : method
    )),
    ["none", "password", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["secondary-password"]],
  );
});

test("terminal SSH keeps keyboard-interactive eligible after password rejection", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["password-then-keyboard-interactive"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "password-then-ki-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "password",
      password: "stale-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "password-then-ki-session" });
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered.map((method) => (
      method && typeof method === "object" ? method.type : method
    )),
    ["none", "password", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["secondary-password"]],
  );
});

test("terminal SSH prefers keyboard-interactive after publickey partial success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["publickey-then-password-and-keyboard-interactive"],
    parseKeyResult: {},
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "publickey-then-ki-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "key",
      privateKey: "INLINE_PRIVATE_KEY",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "publickey-then-ki-session" });
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered.map((method) => (
      method && typeof method === "object" ? method.type : method
    )),
    ["none", "publickey", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["secondary-password"]],
  );
});

test("terminal SSH certificate auth prefers keyboard-interactive after agent partial success after partial success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["agent-then-password-and-keyboard-interactive"],
    parseKeyResult: {},
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "certificate-then-ki-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "certificate",
      certificate: "ssh-rsa-cert-v01@openssh.com AAAA test-cert",
      privateKey: "INLINE_PRIVATE_KEY",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "certificate-then-ki-session" });
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    ["none", "agent", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["secondary-password"]],
  );
});

test("terminal SSH certificate auth retries keyboard-interactive when password rejection removes KI", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: [
      "agent-password-removes-keyboard-interactive",
      "agent-then-keyboard-interactive-after-skip-password",
    ],
    parseKeyResult: {},
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender },
    {
      sessionId: "certificate-ki-first-retry-session",
      hostname: "corp-edr.example.com",
      username: "alice",
      authMethod: "certificate",
      certificate: "ssh-rsa-cert-v01@openssh.com AAAA test-cert",
      privateKey: "INLINE_PRIVATE_KEY",
      password: "login-password",
      useSshAgent: false,
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "certificate-ki-first-retry-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    ["none", "agent", "password", false],
  );
  assert.deepEqual(
    MockSSHClient.instances[1].authMethodsOffered,
    ["none", "agent", "keyboard-interactive", "keyboard-interactive"],
  );
  assert.deepEqual(
    MockSSHClient.instances[1].keyboardInteractiveResponses,
    [["login-password"], ["secondary-password"]],
  );
});

test("terminal SSH stops after two successful keyboard-interactive factors", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["excessive-keyboard-interactive"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const sender = makeSender();
  const send = sender.send.bind(sender);
  sender.send = (channel, payload) => {
    send(channel, payload);
    if (channel === "netcatty:keyboard-interactive") {
      keyboardInteractiveHandler.handleResponse(
        { sender },
        {
          requestId: payload.requestId,
          responses: ["secondary-password"],
          cancelled: false,
        },
      );
    }
  };

  await assert.rejects(
    ipcMain.handlers.get("netcatty:start")(
      { sender },
      {
        sessionId: "excessive-ki-session",
        hostname: "corp-edr.example.com",
        username: "alice",
        authMethod: "password",
        password: "login-password",
        useSshAgent: false,
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  assert.deepEqual(
    MockSSHClient.instances[0].authMethodsOffered,
    ["none", "keyboard-interactive", "keyboard-interactive", false],
  );
  assert.deepEqual(
    MockSSHClient.instances[0].keyboardInteractiveResponses,
    [["login-password"], ["secondary-password"]],
  );
});

test("fresh SSH sessions preserve the server locale for the default UTF-8 charset", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["ready"],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);

  const result = await ipcMain.handlers.get("netcatty:start")(
    { sender: makeSender() },
    {
      sessionId: "default-locale-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      charset: "UTF-8",
      env: { TERM: "xterm-256color" },
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "default-locale-session" });
  assert.deepEqual(MockSSHClient.instances[0].shellOptions.env, {
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
  });
});

test("retryable encrypted-key auth failure does not emit exit before retry success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  const result = await start(
    { sender },
    {
      sessionId: "retry-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "retry-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "retry-session"
    )),
    false,
  );
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:auth:failed"
      && message.payload.sessionId === "retry-session"
    )),
    true,
  );
});

test("stale close from failed first attempt does not close successful retry session", async (t) => {
  const sessions = new Map();
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await start(
    { sender },
    {
      sessionId: "stale-close-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(sessions.has("stale-close-session"), true);

  MockSSHClient.instances[0].emit("close");
  await nextTick();

  assert.equal(sessions.has("stale-close-session"), true);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "stale-close-session"
    )),
    false,
  );
});

test("stale error from failed first attempt does not mark successful retry session failed", async (t) => {
  const sessions = new Map();
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await start(
    { sender },
    {
      sessionId: "stale-error-session",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(sessions.has("stale-error-session"), true);

  const err = new Error("late error from failed first attempt");
  err.level = "client-socket";
  MockSSHClient.instances[0].emit("error", err);
  await nextTick();

  assert.equal(sessions.get("stale-error-session")._transportError, undefined);
});

test("jump-host auth failure does not emit exit before encrypted-key retry success", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  const result = await start(
    { sender },
    {
      sessionId: "jump-retry-session",
      hostname: "target.example",
      username: "alice",
      port: 22,
      knownHosts: [],
      jumpHosts: [{ hostname: "jump.example", username: "alice", port: 22 }],
    },
  );

  assert.deepEqual(result, { sessionId: "jump-retry-session" });
  assert.equal(MockSSHClient.connectCount, 3);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-retry-session"
    )),
    false,
  );
});

test("jump-host auth failure is attributed to the failing jump host", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-auth-failed-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion"/);
      return true;
    },
  );
});

test("jump-host too-many-auth failures are attributed to the failing jump host", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["too-many-auth"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-too-many-auth-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion": Too many authentication failures/);
      return true;
    },
  );
});

test("jump-host auth attribution survives encrypted-key retry failure", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "auth-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");

  await assert.rejects(
    start(
      { sender: makeSender() },
      {
        sessionId: "jump-auth-retry-failed-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "jump.example",
          username: "jump-user",
          port: 22,
          label: "Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isJumpHostAuthError, true);
      assert.equal(err.jumpHostLabel, "Bastion");
      assert.match(err.message, /Jump host authentication failed for "Bastion"/);
      return true;
    },
  );
});

test("jump-host socket errors with auth in hostname are not wrapped as auth failures", async (t) => {
  let passphraseRequests = 0;
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["socket-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    onPassphraseRequest: () => {
      passphraseRequests += 1;
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    start(
      { sender },
      {
        sessionId: "jump-socket-error-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "auth-bastion.example.com",
          username: "jump-user",
          port: 22,
          label: "Auth Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.equal(err.isJumpHostAuthError, undefined);
      assert.equal(err.level, "client-socket");
      assert.equal(err.message, "Connection reset by auth-bastion.example.com");
      return true;
    },
  );
  assert.equal(passphraseRequests, 0);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-socket-error-session"
      && message.payload.error === "Connection reset by auth-bastion.example.com"
    )),
    true,
  );
});

test("jump-host permission-denied socket errors are not wrapped as auth failures", async (t) => {
  let passphraseRequests = 0;
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["permission-denied-socket-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    onPassphraseRequest: () => {
      passphraseRequests += 1;
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    start(
      { sender },
      {
        sessionId: "jump-permission-denied-socket-error-session",
        hostname: "target.example",
        username: "target-user",
        port: 22,
        knownHosts: [],
        jumpHosts: [{
          hostname: "auth-bastion.example.com",
          username: "jump-user",
          port: 22,
          label: "Auth Bastion",
        }],
      },
    ),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.equal(err.isJumpHostAuthError, undefined);
      assert.equal(err.level, "client-socket");
      assert.equal(err.message, "Permission denied opening channel to auth-bastion.example.com");
      return true;
    },
  );
  assert.equal(passphraseRequests, 0);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "jump-permission-denied-socket-error-session"
      && message.payload.error === "Permission denied opening channel to auth-bastion.example.com"
    )),
    true,
  );
});

test("fresh fallback after reuse failure still retries encrypted default key", async (t) => {
  const events = [];
  const sessions = new Map([
    [
      "source",
      makeReusableSourceSession({
        hostname: "example.test",
        username: "alice",
        port: 22,
      }),
    ],
  ]);
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
    onPassphraseRequest: () => events.push("passphrase-request"),
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender(events);

  const result = await start(
    { sender },
    {
      sessionId: "reuse-fallback-retry-session",
      sourceSessionId: "source",
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
    },
  );

  assert.deepEqual(result, { sessionId: "reuse-fallback-retry-session" });
  assert.equal(MockSSHClient.instances.length, 2);
  assert.equal(events.includes("passphrase-request"), true);
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:connection-reuse:fallback"
      && message.payload.sessionId === "reuse-fallback-retry-session"
    )),
    true,
  );
  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:exit"
      && message.payload.sessionId === "reuse-fallback-retry-session"
    )),
    false,
  );
});

test("fresh fallback after reuse failure without encrypted keys emits one final exit", async (t) => {
  const sessions = new Map([
    [
      "source",
      makeReusableSourceSession({
        hostname: "example.test",
        username: "alice",
        port: 22,
      }),
    ],
  ]);
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "reuse-fallback-failed-session",
        sourceSessionId: "source",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  assert.equal(
    sender.sent.some((message) => (
      message.channel === "netcatty:connection-reuse:fallback"
      && message.payload.sessionId === "reuse-fallback-failed-session"
    )),
    true,
  );
  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "reuse-fallback-failed-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
});

test("stale close from failed encrypted-key retry does not stop successful retry log stream", async (t) => {
  const sessionId = "retry-session-log";
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-auth-retry-log-"));
  t.after(async () => {
    await sessionLogStreamManager.stopStream(sessionId);
    fs.rmSync(logDirectory, { recursive: true, force: true });
  });

  const sessions = new Map();
  const { bridge, MockSSHClient } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error", "ready"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: false,
      keys: [
        {
          keyPath: "/Users/test/.ssh/id_ed25519",
          keyName: "id_ed25519",
          privateKey: "UNLOCKED_PRIVATE_KEY",
          passphrase: "secret",
        },
      ],
    },
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions, electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await start(
    { sender },
    {
      sessionId,
      hostname: "example.test",
      username: "alice",
      port: 22,
      knownHosts: [],
      sessionLog: {
        enabled: true,
        directory: logDirectory,
        format: "raw",
      },
    },
  );

  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);

  MockSSHClient.instances[0].emit("close");
  await nextTick();

  assert.equal(sessionLogStreamManager.hasStream(sessionId), true);
});

test("non-retryable auth failure still emits one exit", async (t) => {
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [],
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender();

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "failed-session",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "failed-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
});

test("cancelled encrypted-key retry emits one final exit", async (t) => {
  const events = [];
  const { bridge } = loadBridgeWithAuthRetryMocks(t, {
    connectEvents: ["auth-error"],
    encryptedKeys: [
      {
        keyPath: "/Users/test/.ssh/id_ed25519",
        keyName: "id_ed25519",
        isEncrypted: true,
      },
    ],
    passphraseResult: {
      cancelled: true,
      keys: [],
    },
    onPassphraseRequest: () => events.push("passphrase-request"),
  });
  const ipcMain = makeIpcMain();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(ipcMain);
  const start = ipcMain.handlers.get("netcatty:start");
  const sender = makeSender(events);

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "cancelled-session",
        hostname: "example.test",
        username: "alice",
        port: 22,
        knownHosts: [],
      },
    ),
    /All configured authentication methods failed/,
  );

  const exits = sender.sent.filter((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "cancelled-session"
  ));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].payload.reason, "error");
  assert.equal(events.includes("passphrase-request"), true);
  assert.equal(
    events.indexOf("send:netcatty:exit") > events.indexOf("passphrase-request"),
    true,
  );
});
