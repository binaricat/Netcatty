"use strict";

/**
 * Integration coverage for #3310: SFTP-tab uploads on OTP (keyboard-
 * interactive) hosts.
 *
 * The SFTP page opens pooled transfer connections through the unified SSH
 * transport registry. When a host authenticates interactively (one-time
 * codes), a second connection must never require another OTP round trip: the
 * pooled transfer open must ride the transport that the interactive login
 * already authenticated. When credentials genuinely diverge (e.g. an OTP was
 * saved into the host record after login), a fresh dial must surface a new
 * keyboard-interactive prompt instead of hanging silently.
 *
 * This test drives the real bridges against an in-process ssh2 server that
 * only accepts keyboard-interactive auth, mirroring the reporter's server.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const tempDirBridge = require("./tempDirBridge.cjs");

const { Server } = require("ssh2");

const pool = require("./sshConnectionPool.cjs");
const kiHandler = require("./keyboardInteractiveHandler.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");

const OTP_CODE = "135790";

// SFTP status codes (RFC draft-ietf-secsh-filexfer-02, section 7).
const STATUS_OK = 0;
const STATUS_EOF = 1;
const STATUS_NO_SUCH_FILE = 2;

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

/**
 * Minimal in-memory fs for the server side: enough of SFTP for Netcatty's
 * upload pipeline (stat / open / write / setstat / rename / backup cleanup).
 */
function makeSftpHandlers(files, dirs, serverControl) {
  const handles = new Map();
  let nextHandle = 1;

  const attrsFor = (p) => {
    if (files.has(p)) {
      return { mode: FILE_MODE, size: files.get(p).length, uid: 0, gid: 0, atime: 0, mtime: 0 };
    }
    if (dirs.has(p)) {
      return { mode: DIR_MODE, size: 4096, uid: 0, gid: 0, atime: 0, mtime: 0 };
    }
    return null;
  };

  const parentDir = (p) => {
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "/" : p.slice(0, idx);
  };

  const ensureParents = (p) => {
    let cur = parentDir(p);
    const missing = [];
    while (cur !== "/" && !dirs.has(cur)) {
      missing.unshift(cur);
      cur = parentDir(cur);
    }
    for (const dir of missing) dirs.add(dir);
  };

  return {
    attach(sftp) {
      sftp.on("REALPATH", (reqid, reqPath) => {
        sftp.name(reqid, [{ filename: reqPath || "/", longname: "drwxr-xr-x", attrs: { mode: DIR_MODE } }]);
      });
      sftp.on("STAT", (reqid, reqPath) => {
        const attrs = attrsFor(reqPath);
        if (attrs) sftp.attrs(reqid, attrs);
        else sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("LSTAT", (reqid, reqPath) => {
        const attrs = attrsFor(reqPath);
        if (attrs) sftp.attrs(reqid, attrs);
        else sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("FSTAT", (reqid, handle) => {
        const entry = handles.get(String(handle));
        const attrs = entry ? attrsFor(entry.path) : null;
        if (attrs) sftp.attrs(reqid, attrs);
        else sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("OPENDIR", (reqid, reqPath) => {
        if (!dirs.has(reqPath)) {
          sftp.status(reqid, STATUS_NO_SUCH_FILE);
          return;
        }
        const handle = Buffer.from(`d${nextHandle++}`);
        handles.set(String(handle), { path: reqPath, dir: true, readPos: 0 });
        sftp.handle(reqid, handle);
      });
      sftp.on("READDIR", (reqid, handle) => {
        const entry = handles.get(String(handle));
        if (!entry) {
          sftp.status(reqid, STATUS_NO_SUCH_FILE);
          return;
        }
        if (entry.readPos !== 0) {
          sftp.status(reqid, STATUS_EOF);
          return;
        }
        entry.readPos = 1;
        const names = [...files.keys(), ...dirs.keys()]
          .filter((p) => parentDir(p) === entry.path && p !== entry.path)
          .map((p) => ({
            filename: p.slice(p.lastIndexOf("/") + 1),
            longname: files.has(p) ? "-rw-r--r--" : "drwxr-xr-x",
            attrs: attrsFor(p),
          }));
        sftp.name(reqid, names);
      });
      sftp.on("OPEN", (reqid, reqPath, flags) => {
        ensureParents(reqPath);
        if (!files.has(reqPath) && !(flags & 0x1)) {
          files.set(reqPath, Buffer.alloc(0));
        }
        const handle = Buffer.from(`f${nextHandle++}`);
        handles.set(String(handle), { path: reqPath, readPos: 0 });
        sftp.handle(reqid, handle);
      });
      sftp.on("READ", (reqid, handle, offset, len) => {
        const entry = handles.get(String(handle));
        const data = entry ? files.get(entry.path) : undefined;
        if (!entry || data === undefined) {
          sftp.status(reqid, STATUS_NO_SUCH_FILE);
          return;
        }
        if (offset >= data.length) {
          sftp.status(reqid, STATUS_EOF);
          return;
        }
        sftp.data(reqid, data.subarray(offset, offset + len));
      });
      sftp.on("WRITE", (reqid, handle, offset, data) => {
        const entry = handles.get(String(handle));
        if (!entry) {
          sftp.status(reqid, STATUS_NO_SUCH_FILE);
          return;
        }
        if (serverControl?.holdWrites) {
          serverControl.writesHeld += 1;
          return;
        }
        const prev = files.get(entry.path) || Buffer.alloc(0);
        const next = Buffer.alloc(Math.max(prev.length, offset + data.length));
        prev.copy(next);
        data.copy(next, offset);
        files.set(entry.path, next);
        sftp.status(reqid, STATUS_OK);
      });
      sftp.on("CLOSE", (reqid, handle) => {
        handles.delete(String(handle));
        sftp.status(reqid, STATUS_OK);
      });
      sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_OK));
      sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_OK));
      sftp.on("REMOVE", (reqid, reqPath) => {
        if (files.delete(reqPath)) sftp.status(reqid, STATUS_OK);
        else sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("RMDIR", (reqid, reqPath) => {
        if (dirs.delete(reqPath)) sftp.status(reqid, STATUS_OK);
        else sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("MKDIR", (reqid, reqPath) => {
        ensureParents(reqPath);
        dirs.add(reqPath);
        sftp.status(reqid, STATUS_OK);
      });
      sftp.on("RENAME", (reqid, from, to) => {
        if (files.has(from)) {
          files.set(to, files.get(from));
          files.delete(from);
          sftp.status(reqid, STATUS_OK);
          return;
        }
        if (dirs.has(from)) {
          dirs.delete(from);
          dirs.add(to);
          sftp.status(reqid, STATUS_OK);
          return;
        }
        sftp.status(reqid, STATUS_NO_SUCH_FILE);
      });
      sftp.on("EXTENDED", (reqid) => sftp.status(reqid, STATUS_OK));
    },
  };
}

function startOtpOnlyServer(serverOptions = {}) {
  return new Promise((resolve, reject) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const files = new Map();
    const dirs = new Set(["/", "/home", "/home/otpuser"]);
    const serverControl = {
      holdWrites: false,
      writesHeld: 0,
      sftpStreams: new Set(),
    };
    const handlers = makeSftpHandlers(files, dirs, serverControl);
    let keyboardInteractiveRounds = 0;

    const sshServer = new Server({
      hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })],
      ...(serverOptions.ident ? { ident: serverOptions.ident } : {}),
    }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        if (ctx.method === "keyboard-interactive") {
          keyboardInteractiveRounds += 1;
          ctx.prompt(
            [{ prompt: "Verification code (OTP):", echo: false }],
            "OTP required",
            "",
            (answers) => {
              if (answers && answers[0] === OTP_CODE) ctx.accept();
              else ctx.reject(["keyboard-interactive"]);
            },
          );
          return;
        }
        // The server refuses everything else: OTP is the only way in.
        ctx.reject(["keyboard-interactive"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptChannel) => {
            const sftp = acceptChannel();
            serverControl.sftpStreams.add(sftp);
            sftp.on("close", () => serverControl.sftpStreams.delete(sftp));
            handlers.attach(sftp);
          });
        });
      });
    });

    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      sshServer.injectSocket(socket);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      files,
      dirs,
      getKeyboardInteractiveRounds: () => keyboardInteractiveRounds,
      getConnectionCount: () => sockets.size,
      holdWrites() { serverControl.holdWrites = true; },
      writesHeld: () => serverControl.writesHeld,
      partPaths: () => [...files.keys()].filter((name) => String(name).endsWith(".part")),
      killSftpChannels() {
        for (const stream of serverControl.sftpStreams) {
          try { stream.destroy(); } catch { /* ignore */ }
        }
      },
      resetConnections() {
        for (const socket of sockets) {
          try {
            if (typeof socket.reset === "function") socket.reset();
            else socket.destroy();
          } catch {
            try { socket.destroy(); } catch { /* ignore */ }
          }
        }
      },
      close: () => new Promise((done) => {
        // Include clients still waiting for authentication, before registration.
        for (const socket of sockets) socket.destroy();
        sshServer.close?.();
        server.close(() => done());
      }),
    }));
  });
}

function createSender() {
  const sender = {
    sent: [],
    isDestroyed: () => false,
    send(channel, payload) {
      sender.sent.push({ channel, payload });
    },
  };
  return sender;
}

/** Answer every pending keyboard-interactive request with the OTP code. */
function answerOtpPrompts(sender) {
  const surfaced = sender.sent.some((s) => s.channel === "netcatty:keyboard-interactive");
  for (const { channel, payload } of sender.sent) {
    if (channel === "netcatty:keyboard-interactive" && kiHandler.getRequests().has(payload.requestId)) {
      kiHandler.handleResponse({ sender }, { requestId: payload.requestId, responses: [OTP_CODE] });
    }
  }
  return surfaced;
}

async function waitFor(condition, { timeoutMs = 8000, stepMs = 25, message } = {}) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += stepMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  assert.ok(condition(), message || "condition not met before timeout");
  return true;
}

const BASE_OPTIONS = (port) => ({
  hostname: "127.0.0.1",
  hostId: "host-otp-3310",
  port,
  username: "otpuser",
  authMethod: "password",
  useSshAgent: false,
  verifyHostKeys: false,
  fileProtocol: "sftp",
  identityFilePaths: [],
});

test("SFTP-page transfers reuse the OTP-authenticated transport (#3310)", async (t) => {
  const server = await startOtpOnlyServer();
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });

  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });

  // Tear down SSH clients and shared transports BEFORE awaiting server
  // closure: node runs `t.after` hooks in registration order, and
  // `net.Server.close()` would hang if an assertion failed while the SSH
  // TCP clients were still connected.
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try {
        await sftpBridge.closeSftp(null, { sftpId });
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const loginEndpointKey = pool.buildEndpointKey(
    pool.buildConnectionReuseEndpoint({ ...options, sessionId: "sftp-browse-otp" }),
  );
  const pooledEndpointKey = pool.buildEndpointKey(pool.buildConnectionReuseEndpoint(options));
  assert.equal(
    pooledEndpointKey,
    loginEndpointKey,
    "pooled transfer opens must resolve to the login endpoint",
  );

  // -- 1. SFTP-page login: keyboard-interactive modal, then browse open. --
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-otp" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {}); // Teardown observes failures if the prompt wait fails first.
  const browseSurfaced = await waitFor(
    () => answerOtpPrompts(browseSender),
    { message: "SFTP-tab login must surface the OTP prompt" },
  );
  assert.ok(browseSurfaced, "OTP prompt must be shown for the SFTP-tab login");
  const browse = await browseOpen;
  assert.equal(browse.fileProtocol, "sftp");
  assert.equal(server.getKeyboardInteractiveRounds(), 1, "exactly one OTP round for login");

  // -- 2. Pooled transfer open: rides the authenticated transport. --
  const transferSender = createSender();
  const transferOpen = sftpBridge.openSftp(
    { sender: transferSender },
    { ...options },
  );
  pendingOpens.push(transferOpen);
  let transferOpenSettled = false;
  transferOpen.then(
    () => { transferOpenSettled = true; },
    () => { transferOpenSettled = true; },
  );
  const transferPrompted = () => transferSender.sent.some(
    (s) => s.channel === "netcatty:keyboard-interactive",
  );
  await waitFor(() => transferOpenSettled || transferPrompted(), {
    message: "pooled transfer open must complete promptly",
  });
  assert.equal(transferPrompted(), false, "pooled transfer open must not prompt again");
  const transfer = await transferOpen;
  const transferClient = sftpClients.get(transfer.sftpId);
  assert.ok(transferClient, "pooled transfer open must register a client");
  assert.equal(
    transferClient.__netcattyTransportManaged,
    true,
    "pooled transfer open must ride the shared transport",
  );
  assert.equal(
    server.getKeyboardInteractiveRounds(),
    1,
    "pooled transfer open must not re-authenticate (no second OTP)",
  );
  const transferChannel = await sftpBridge.requireSftpChannel(transferClient);
  assert.ok(transferChannel, "shared transport must host the transfer SFTP channel");

  // -- 3. Stream upload over the reused session completes. --
  const tempRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("otp-reuse-upload")}-`);
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const localFile = path.join(tempRoot, "upload.txt");
  const payload = Buffer.from("hello otp upload\n");
  fs.writeFileSync(localFile, payload);

  const lifecycleEvents = [];
  const uploadSender = { send: (channel, event) => lifecycleEvents.push({ channel, event }) };
  const streamResult = await transferBridge.startTransfer(
    { sender: uploadSender },
    {
      transferId: "otp-reuse-stream-1",
      sourcePath: localFile,
      targetPath: "/home/otpuser/stream-upload.txt",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: transfer.sftpId,
      targetEncoding: "utf-8",
      totalBytes: payload.length,
    },
  );
  assert.equal(
    streamResult?.error,
    undefined,
    `stream upload over the reused OTP transport must succeed: ${streamResult?.error}`,
  );
  assert.ok(
    lifecycleEvents.some((e) => e.channel === "netcatty:transfer:started"),
    "stream upload must emit transfer lifecycle events",
  );
  assert.equal(
    Buffer.from(server.files.get("/home/otpuser/stream-upload.txt") || Buffer.alloc(0)).toString("utf-8"),
    payload.toString("utf-8"),
    "remote file must contain the uploaded payload",
  );
  assert.equal(server.getKeyboardInteractiveRounds(), 1, "upload must not re-authenticate");

  // -- 4. Credential drift: fresh dial must surface a new OTP prompt, --
  // not hang silently (e.g. an OTP saved into the host record after login).
  const driftSender = createSender();
  const driftOpen = sftpBridge.openSftp(
    { sender: driftSender },
    { ...options, password: "one-time-code-not-valid-anymore" },
  );
  pendingOpens.push(driftOpen);
  driftOpen.catch(() => {});
  await waitFor(
    () =>
      driftSender.sent.some((s) => s.channel === "netcatty:keyboard-interactive") &&
      server.getKeyboardInteractiveRounds() >= 2,
    { message: "drifted transfer open must surface a fresh OTP prompt" },
  );
  const driftSurfaced = answerOtpPrompts(driftSender);
  assert.ok(driftSurfaced, "fresh OTP prompt must actually reach the renderer sender");
  const drifted = await driftOpen;
  assert.equal(
    sftpClients.get(drifted.sftpId)?.__netcattyTransportManaged,
    true,
    "drifted dial must still register a transport-managed client",
  );
});

test("single-channel OTP SFTP reuses the authenticated channel instead of hanging (#3310)", { timeout: 20000 }, async (t) => {
  // TERM-SSHD allows one session channel. The SFTP page login succeeds, but
  // that connection is intentionally not parked as a shareable transport.
  // A transfer must reuse the live channel (no second OTP) and must not wait
  // forever on the login dial.
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });

  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });

  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try {
        await sftpBridge.closeSftp(null, { sftpId });
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-single-channel" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(
    () => answerOtpPrompts(browseSender),
    { message: "single-channel SFTP login must surface the OTP prompt" },
  );
  const browse = await browseOpen;
  assert.equal(server.getKeyboardInteractiveRounds(), 1);
  assert.equal(server.getConnectionCount(), 1);
  const browseClient = sftpClients.get(browse.sftpId);
  assert.equal(browseClient?.__netcattySingleChannelSsh, true);
  assert.notEqual(browseClient?.__netcattyTransportManaged, true);

  const transferSender = createSender();
  const transferOpen = sftpBridge.openSftp(
    { sender: transferSender },
    { ...options },
  );
  pendingOpens.push(transferOpen);
  let transferOpenSettled = false;
  transferOpen.then(
    () => { transferOpenSettled = true; },
    () => { transferOpenSettled = true; },
  );
  const transferPrompted = () => transferSender.sent.some(
    (entry) => entry.channel === "netcatty:keyboard-interactive",
  );
  await waitFor(() => transferOpenSettled || transferPrompted(), {
    timeoutMs: 4000,
    message: "single-channel transfer open must not wait forever for another OTP",
  });
  assert.equal(transferPrompted(), false, "transfer must reuse the authenticated channel");
  const transfer = await transferOpen;
  const transferClient = sftpClients.get(transfer.sftpId);
  assert.equal(transferClient?.__netcattySharedChannelAlias, true);
  assert.equal(server.getKeyboardInteractiveRounds(), 1);
  assert.equal(server.getConnectionCount(), 1, "transfer must not dial a second SSH connection");

  const tempRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("otp-single-channel-upload")}-`);
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const localFile = path.join(tempRoot, "upload.txt");
  const payload = Buffer.from("single-channel otp upload\n");
  fs.writeFileSync(localFile, payload);
  const streamResult = await transferBridge.startTransfer(
    { sender: { send() {} } },
    {
      transferId: "otp-single-channel-stream-1",
      sourcePath: localFile,
      targetPath: "/home/otpuser/single-channel-upload.txt",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: transfer.sftpId,
      targetEncoding: "utf-8",
      totalBytes: payload.length,
    },
  );
  assert.equal(streamResult?.error, undefined, `upload must finish: ${streamResult?.error}`);
  assert.equal(
    Buffer.from(server.files.get("/home/otpuser/single-channel-upload.txt") || Buffer.alloc(0)).toString("utf-8"),
    payload.toString("utf-8"),
  );
  assert.equal(server.getKeyboardInteractiveRounds(), 1);

  await sftpBridge.closeSftp(null, { sftpId: transfer.sftpId });
  assert.equal(sftpClients.has(transfer.sftpId), false);
  const browseChannel = await sftpBridge.requireSftpChannel(browseClient);
  assert.equal(typeof browseChannel?.stat, "function", "closing the transfer alias must keep the login channel");
  await new Promise((resolve, reject) => {
    browseChannel.stat("/home/otpuser/single-channel-upload.txt", (err) => (err ? reject(err) : resolve()));
  });

  // Without the live channel, a later open must surface OTP instead of
  // joining the login dial forever.
  sftpClients.delete(browse.sftpId);
  const freshSender = createSender();
  const freshOpen = sftpBridge.openSftp(
    { sender: freshSender },
    { ...options, sessionId: "sftp-single-channel-redial" },
  );
  pendingOpens.push(freshOpen);
  freshOpen.catch(() => {});
  await waitFor(
    () => freshSender.sent.some((entry) => entry.channel === "netcatty:keyboard-interactive"),
    { timeoutMs: 4000, message: "a required new connection must surface OTP instead of hanging" },
  );
  assert.ok(answerOtpPrompts(freshSender));
  const fresh = await freshOpen;
  assert.ok(fresh.sftpId);
  assert.equal(server.getKeyboardInteractiveRounds(), 2);
});

test("closing the single-channel owner mid-upload defers teardown and a dead channel fails the borrow (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });

  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try {
        await sftpBridge.closeSftp(null, { sftpId });
      } catch {
        // Best-effort cleanup.
      }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-owner-close" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(
    () => answerOtpPrompts(browseSender),
    { message: "owner login must surface the OTP prompt" },
  );
  const browse = await browseOpen;
  const browseClient = sftpClients.get(browse.sftpId);
  const transfer = await sftpBridge.openSftp({ sender: createSender() }, { ...options });
  const alias = sftpClients.get(transfer.sftpId);
  assert.equal(alias?.__netcattySharedChannelAlias, true);
  assert.equal(alias?.__netcattySharedChannelOwnerId, browse.sftpId);

  const channel = browseClient.sftp;
  const originalWrite = channel.write;
  let heldWrites = 0;
  // SFTP WRITE is (handle, buffer, offset, length, position, cb). Leave the
  // stream write() used by the SSH channel itself alone so client.end() can
  // still close the socket.
  channel.write = function writeHeld(...args) {
    if (typeof args[5] === "function" && typeof args[4] === "number") {
      heldWrites += 1;
      return;
    }
    return originalWrite.apply(this, args);
  };
  t.after(() => {
    channel.write = originalWrite;
  });

  const tempRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("otp-owner-close-upload")}-`);
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const localFile = path.join(tempRoot, "upload.txt");
  const payload = Buffer.from("owner-close mid upload\n");
  fs.writeFileSync(localFile, payload);
  const transferEvents = [];
  let transferSettled = false;
  const transferPromise = transferBridge.startTransfer(
    {
      sender: {
        send(channelName, eventPayload) {
          transferEvents.push({ channel: channelName, payload: eventPayload });
        },
      },
    },
    {
      transferId: "otp-owner-close-stream-1",
      sourcePath: localFile,
      targetPath: "/home/otpuser/owner-close-upload.txt",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: transfer.sftpId,
      targetEncoding: "utf-8",
      totalBytes: payload.length,
    },
  ).then((result) => {
    transferSettled = true;
    return result;
  });
  pendingOpens.push(transferPromise.catch(() => {}));

  await waitFor(() => heldWrites > 0, {
    timeoutMs: 4000,
    message: "upload must reach a WRITE before the SFTP tab closes",
  });
  const closed = await sftpBridge.closeSftp(null, { sftpId: browse.sftpId });
  assert.equal(closed?.deferred, true, "borrowed upload must keep the owner client open");
  assert.equal(server.getConnectionCount(), 1, "closing the SFTP tab must not drop the shared SSH connection");
  assert.equal(sftpClients.has(browse.sftpId), true);
  assert.equal(transferSettled, false, "the upload is still in flight when the tab closes");

  // The tab close deferred teardown. If the channel dies anyway, the borrow
  // must surface an error instead of sitting at a partial percent.
  const ended = browseClient.end().catch(() => {});
  let hangTimer = null;
  const result = await Promise.race([
    transferPromise,
    new Promise((_, reject) => {
      hangTimer = setTimeout(() => reject(new Error("borrowed upload hung after the owner channel died")), 4000);
    }),
  ]);
  clearTimeout(hangTimer);
  let endTimer = null;
  await Promise.race([
    ended,
    new Promise((resolve) => {
      endTimer = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(endTimer);
  assert.equal(transferSettled, true);
  assert.match(result?.error || "", /SFTP channel closed/);
  assert.ok(
    transferEvents.some((event) => (
      event.channel === "netcatty:transfer:error"
      && /SFTP channel closed/.test(String(event.payload?.error || ""))
    )),
    "the transfer error must be visible to the UI",
  );

  await sftpBridge.closeSftp(null, { sftpId: transfer.sftpId });
  await waitFor(() => !sftpClients.has(browse.sftpId), {
    timeoutMs: 2000,
    message: "the owner client must end after the last borrower releases",
  });
});

test("sudo SFTP-page transfer reuses the elevated channel instead of dialing again", async (t) => {
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const options = {
    hostname: "sudo.example",
    hostId: "host-sudo-otp",
    port: 22,
    username: "root",
    authMethod: "password",
    sudo: true,
    verifyHostKeys: false,
    fileProtocol: "sftp",
    useSshAgent: false,
  };
  const endpoint = pool.buildConnectionReuseEndpoint(options, { sftpSudo: true });
  let channelEnded = false;
  const channel = {
    readdir() {},
    stat() {},
    open() {},
    end() { channelEnded = true; },
  };
  sftpClients.set("browse-sudo", {
    client: {},
    sftp: channel,
    __netcattyEndpointKey: pool.buildEndpointKey(endpoint),
    __netcattyChannelAdoptionKey: pool.buildChannelAdoptionKey(endpoint),
    __netcattySudoMode: true,
    __netcattyFileProtocol: "sftp",
    __netcattyTransportManaged: false,
  });

  await assert.rejects(
    sftpBridge.openSftp(
      { sender: createSender() },
      { ...options, fileProtocol: "scp" },
    ),
    /Sudo Mode is not supported with File Protocol set to SCP/,
  );
  assert.equal(sftpClients.size, 1, "scp+sudo must not borrow the elevated SFTP channel");
  assert.equal(channelEnded, false);

  const opened = await sftpBridge.openSftp({ sender: createSender() }, options);
  const alias = sftpClients.get(opened.sftpId);
  assert.equal(alias?.__netcattySharedChannelAlias, true);
  assert.equal(alias?.sftp, channel, "upload must keep the already-elevated SFTP channel");
  assert.equal(opened.fileProtocol, "sftp");

  await sftpBridge.closeSftp(null, { sftpId: opened.sftpId });
  assert.equal(sftpClients.has(opened.sftpId), false);
  assert.equal(channelEnded, false, "closing the transfer must not drop the sudo login channel");
  assert.equal(sftpClients.has("browse-sudo"), true);
});

for (const [ident, sequential] of [
  ["OpenSSH_9.6", false],
  ["CLOUDBILITY-4.14", true],
  ["TERM-SSHD", true],
]) {
  test(`sudo transfer aliases preserve ${ident} upload concurrency`, { timeout: 15000 }, async (t) => {
    const server = await startOtpOnlyServer({ ident });
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
    const sftpClients = new Map();
    sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
    transferBridge.init({ sftpClients });
    t.after(async () => {
      for (const sftpId of [...sftpClients.keys()].reverse()) {
        await sftpBridge.closeSftp(null, { sftpId }).catch(() => {});
      }
      pool.discardAllTransports("test-end");
      pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
      await server.close();
    });

    const options = { ...BASE_OPTIONS(server.port), reuseTransport: false };
    const sender = createSender();
    const opening = sftpBridge.openSftp({ sender }, { ...options, sessionId: "sudo-owner" });
    opening.catch(() => {});
    await waitFor(() => answerOtpPrompts(sender));
    const opened = await opening;
    const owner = sftpClients.get(opened.sftpId);
    // Model an already-elevated channel. The real SSH/SFTP peer remains the
    // ordinary server or bastion above; no second sudo/authentication is needed.
    const sudoOptions = { ...BASE_OPTIONS(server.port), sudo: true };
    const endpoint = pool.buildConnectionReuseEndpoint(sudoOptions, { sftpSudo: true });
    owner.__netcattySudoMode = true;
    owner.__netcattyEndpointKey = pool.buildEndpointKey(endpoint);
    owner.__netcattyChannelAdoptionKey = pool.buildChannelAdoptionKey(endpoint);
    const firstAlias = await sftpBridge.openSftp({ sender: createSender() }, sudoOptions);
    const secondAlias = await sftpBridge.openSftp({ sender: createSender() }, sudoOptions);
    for (const alias of [firstAlias, secondAlias]) {
      const client = sftpClients.get(alias.sftpId);
      assert.equal(client.__netcattySharedChannelAlias, true);
      assert.equal(client.__netcattySudoMode, true);
      assert.equal(client.sftp, owner.sftp, "both uploads must retain the elevated channel");
    }

    const root = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("sudo-concurrency")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source.bin");
    const payload = Buffer.alloc(3 * 32768 + 17, 0x5a);
    fs.writeFileSync(source, payload);
    const firstPath = "/home/otpuser/first.bin";
    const secondPath = "/home/otpuser/second.bin";
    server.files.set(firstPath, Buffer.from("original file"));
    const channel = owner.sftp;
    const originalLstat = channel.lstat.bind(channel);
    let firstTargetChecks = 0;
    let promotionStarted;
    const promotionStartedPromise = new Promise((resolve) => { promotionStarted = resolve; });
    let releasePromotion;
    const promotionGate = new Promise((resolve) => { releasePromotion = resolve; });
    channel.lstat = (remotePath, ...args) => {
      if (String(remotePath) === firstPath && ++firstTargetChecks === 2) {
        promotionStarted();
        void promotionGate.then(() => originalLstat(remotePath, ...args));
        return;
      }
      originalLstat(remotePath, ...args);
    };
    const upload = (alias, targetPath) => transferBridge.startTransfer({ sender: createSender() }, {
      transferId: `sudo-concurrency-${ident}-${path.basename(targetPath)}`,
      sourcePath: source, targetPath,
      sourceType: "local", targetType: "sftp", targetSftpId: alias.sftpId,
      totalBytes: payload.length, resumable: true,
    });
    let firstFinished = false;
    let secondFinished = false;
    const first = upload(firstAlias, firstPath).then((result) => { firstFinished = true; return result; });
    let second;
    let results;
    try {
      await promotionStartedPromise;
      second = upload(secondAlias, secondPath).then((result) => { secondFinished = true; return result; });
      await waitFor(() => secondFinished
        || transferBridge._getSessionFastDownloadWaiterCountForTests(channel) > 0);
      assert.equal(firstFinished, false, "the first upload must still be held before publication");
      assert.equal(secondFinished, !sequential,
        sequential ? "a bastion must wait for the first promotion" : "ordinary sudo uploads must remain concurrent");
      assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(channel), sequential ? 1 : 0);
    } finally {
      releasePromotion();
      results = await Promise.all(second ? [first, second] : [first]);
      channel.lstat = originalLstat;
    }
    for (const result of results) assert.equal(result.error, undefined, result.error);
    assert.deepEqual(server.files.get(firstPath), payload);
    assert.deepEqual(server.files.get(secondPath), payload);
    assert.equal(server.getConnectionCount(), 1, "sudo uploads must not open an unelevated connection");
    assert.equal(server.getKeyboardInteractiveRounds(), 1, "uploads must not ask for another OTP");
  });
}

test("reconnecting the soft-closed owner id does not replace it with a self-alias (#3310)", async (t) => {
  const { sftpTransferSessionLeaseStore, channelAliasLeaseId } = require("./sftpTransferSessionLease.cjs");
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  sftpTransferSessionLeaseStore.resetForTests();
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
    sftpTransferSessionLeaseStore.resetForTests();
  });
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  const ownerId = "sftp-pane";
  const options = {
    hostname: "same-id.example",
    hostId: "host-same-id",
    port: 22,
    username: "root",
    authMethod: "password",
    verifyHostKeys: false,
    fileProtocol: "sftp",
    useSshAgent: false,
    sessionId: ownerId,
  };
  const endpoint = pool.buildConnectionReuseEndpoint(options, { sftpSudo: false });
  let ownerEnded = false;
  const owner = {
    client: { end() { ownerEnded = true; } },
    sftp: { readdir() {}, stat() {}, open() {} },
    __netcattyEndpointKey: pool.buildEndpointKey(endpoint),
    __netcattyChannelAdoptionKey: pool.buildChannelAdoptionKey(endpoint),
    __netcattySingleChannelSsh: true,
    __netcattyFileProtocol: "sftp",
    __netcattyTransportManaged: false,
    async end() { ownerEnded = true; },
  };
  sftpClients.set(ownerId, owner);
  assert.equal(sftpTransferSessionLeaseStore.acquire(ownerId, "upload-1"), true);
  const closed = await sftpBridge.closeSftp(null, { sftpId: ownerId });
  assert.equal(closed?.deferred, true);

  const reopened = await sftpBridge.openSftp({ sender: createSender() }, options);
  assert.notEqual(reopened.sftpId, ownerId);
  assert.equal(sftpClients.get(ownerId), owner, "the SSH client must stay under its own id");
  assert.equal(owner.__netcattySharedChannelAlias, undefined);
  const alias = sftpClients.get(reopened.sftpId);
  assert.equal(alias?.__netcattySharedChannelAlias, true);
  assert.equal(alias?.__netcattySharedChannelOwnerId, ownerId);
  assert.equal(alias?.sftp, owner.sftp);
  const leases = sftpTransferSessionLeaseStore.listTransferIds(ownerId);
  assert.equal(leases.includes(channelAliasLeaseId(ownerId)), false);
  assert.equal(leases.includes(channelAliasLeaseId(reopened.sftpId)), true);
  assert.equal(ownerEnded, false);

  sftpTransferSessionLeaseStore.release(ownerId, "upload-1");
  assert.equal(ownerEnded, false, "the reconnect alias still holds the owner");
  await sftpBridge.closeSftp(null, { sftpId: reopened.sftpId });
  await waitFor(() => ownerEnded && !sftpClients.has(ownerId), {
    timeoutMs: 2000,
    message: "releasing the reconnect alias must hard-close the original client",
  });
});

test("channel adoption reuses a still-trusted host key and rejects a replaced or removed one (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => {
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });

  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    for (const [id, pending] of hostKeyVerifier.getRequests()) {
      hostKeyVerifier.handleResponse(
        { sender: { id: pending.webContentsId } },
        { requestId: id, accept: false },
      );
    }
    pool.discardAllTransports("test-end");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const probeSender = createSender();
  const probeOpen = sftpBridge.openSftp(
    { sender: probeSender },
    {
      ...BASE_OPTIONS(server.port),
      sessionId: "sftp-probe-host-key",
      verifyHostKeys: true,
      knownHosts: [],
    },
  );
  pendingOpens.push(probeOpen);
  probeOpen.catch(() => {});
  await waitFor(
    () => probeSender.sent.some((entry) => entry.channel === "netcatty:host-key:verify"),
    { timeoutMs: 4000, message: "the first connect must surface a host-key prompt" },
  );
  const prompt = probeSender.sent.find((entry) => entry.channel === "netcatty:host-key:verify");
  const trusted = {
    id: "kh-otp",
    hostname: "127.0.0.1",
    port: server.port,
    keyType: prompt.payload.keyType,
    publicKey: prompt.payload.publicKey,
    fingerprint: prompt.payload.fingerprint,
    discoveredAt: 1,
  };
  hostKeyVerifier.handleResponse(
    { sender: probeSender },
    { requestId: prompt.payload.requestId, accept: false },
  );
  await probeOpen.catch(() => {});

  const browseOptions = {
    ...BASE_OPTIONS(server.port),
    verifyHostKeys: true,
    knownHosts: [trusted],
    sessionId: "sftp-browse-after-trust",
  };
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp({ sender: browseSender }, browseOptions);
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(
    () => answerOtpPrompts(browseSender),
    { message: "reopened SFTP page must still prompt for OTP" },
  );
  const browse = await browseOpen;
  const browseClient = sftpClients.get(browse.sftpId);
  assert.ok(browseClient.__netcattyAcceptedHostKeys?.length >= 1);
  const stillTrusted = {
    ...BASE_OPTIONS(server.port),
    verifyHostKeys: true,
    knownHosts: [
      trusted,
      {
        ...trusted,
        id: "kh-other-algo",
        keyType: trusted.keyType === "ssh-rsa" ? "ssh-ed25519" : "ssh-rsa",
        fingerprint: "unrelated-fingerprint",
        publicKey: "ssh-ed25519 AAAA",
      },
    ],
    hostKeyUnattended: true,
  };
  const stillTrustedEndpoint = pool.buildConnectionReuseEndpoint(stillTrusted, { sftpSudo: false });
  assert.notEqual(
    browseClient.__netcattyEndpointKey,
    pool.buildEndpointKey(stillTrustedEndpoint),
    "an extra known-host record must change the host-key digest",
  );
  assert.equal(
    browseClient.__netcattyChannelAdoptionKey,
    pool.buildChannelAdoptionKey(stillTrustedEndpoint),
  );

  const transfer = await sftpBridge.openSftp({ sender: createSender() }, stillTrusted);
  const alias = sftpClients.get(transfer.sftpId);
  assert.equal(alias?.__netcattySharedChannelAlias, true);
  assert.equal(server.getConnectionCount(), 1, "a still-trusted key must not dial a second SSH connection");
  assert.equal(server.getKeyboardInteractiveRounds(), 1);
  await sftpBridge.closeSftp(null, { sftpId: transfer.sftpId });

  const ownerCount = sftpClients.size;
  const replaced = {
    ...stillTrusted,
    knownHosts: [{
      ...trusted,
      fingerprint: "replaced-fingerprint",
      publicKey: `${trusted.keyType || "ssh-ed25519"} AAAA`,
    }],
  };
  const replacedSender = createSender();
  const replacedStarted = Date.now();
  const replacedOpen = sftpBridge.openSftp({ sender: replacedSender }, replaced);
  pendingOpens.push(replacedOpen);
  replacedOpen.catch(() => {});
  await assert.rejects(replacedOpen, /Host key verification required/);
  assert.ok(Date.now() - replacedStarted < 4000, "a replaced host key must not wait on verification");
  assert.equal(sftpClients.size, ownerCount, "a replaced host key must not borrow the old channel");
  assert.equal(
    replacedSender.sent.some((entry) => entry.channel === "netcatty:host-key:verify"),
    false,
  );

  const revokedSender = createSender();
  const revokedOpen = sftpBridge.openSftp(
    { sender: revokedSender },
    { ...stillTrusted, knownHosts: [] },
  );
  pendingOpens.push(revokedOpen);
  revokedOpen.catch(() => {});
  await assert.rejects(revokedOpen, /Host key verification required/);
  assert.equal(sftpClients.size, ownerCount, "a removed host key must not borrow the old channel");

  await sftpBridge.closeSftp(null, { sftpId: browse.sftpId });
  await waitFor(() => !sftpClients.has(browse.sftpId), { timeoutMs: 2000 });
});

test("an exact endpoint match still rejects a host key removed after it was trusted (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    for (const [id, pending] of hostKeyVerifier.getRequests()) {
      hostKeyVerifier.handleResponse(
        { sender: { id: pending.webContentsId } },
        { requestId: id, accept: false },
      );
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    {
      ...BASE_OPTIONS(server.port),
      sessionId: "sftp-browse-trust-then-remove",
      verifyHostKeys: true,
      knownHosts: [],
    },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(
    () => browseSender.sent.some((entry) => entry.channel === "netcatty:host-key:verify"),
    { timeoutMs: 4000, message: "the first open must prompt for the host key" },
  );
  const prompt = browseSender.sent.find((entry) => entry.channel === "netcatty:host-key:verify");
  hostKeyVerifier.handleResponse(
    { sender: browseSender },
    { requestId: prompt.payload.requestId, accept: true },
  );
  await waitFor(
    () => answerOtpPrompts(browseSender),
    { message: "accepting the host key must continue to OTP" },
  );
  const browse = await browseOpen;
  const browseClient = sftpClients.get(browse.sftpId);
  assert.ok(browseClient.__netcattyAcceptedHostKeys?.length >= 1);

  const removed = {
    ...BASE_OPTIONS(server.port),
    verifyHostKeys: true,
    knownHosts: [],
    hostKeyUnattended: true,
  };
  const removedEndpoint = pool.buildConnectionReuseEndpoint(removed, { sftpSudo: false });
  assert.equal(
    browseClient.__netcattyEndpointKey,
    pool.buildEndpointKey(removedEndpoint),
    "trust-then-delete leaves both sides on the empty known-hosts digest",
  );
  const ownerCount = sftpClients.size;
  const removedSender = createSender();
  const removedOpen = sftpBridge.openSftp({ sender: removedSender }, removed);
  pendingOpens.push(removedOpen);
  removedOpen.catch(() => {});
  await assert.rejects(removedOpen, /Host key verification required/);
  assert.equal(sftpClients.size, ownerCount, "a removed host key must not borrow the old channel");
  assert.equal(
    [...sftpClients.values()].some((client) => client.__netcattySharedChannelAlias),
    false,
  );
  assert.equal(
    removedSender.sent.some((entry) => entry.channel === "netcatty:host-key:verify"),
    false,
  );
});

test("a jump host that still verifies is not adopted after its pin is removed (#3310)", async (t) => {
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    pool.discardAllTransports("test-end");
  });

  const jumpPin = {
    hostname: "127.0.0.1",
    port: 1,
    keyType: "ssh-ed25519",
    fingerprint: "JUMPPIN",
    publicKey: "ssh-ed25519 AAAA_JUMP_PIN",
  };
  const optionsFor = (knownHosts) => ({
    hostname: "target.example",
    hostId: "jump-pin-adopt",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "secret",
    useSshAgent: false,
    verifyHostKeys: false,
    knownHosts,
    jumpHosts: [{
      hostname: "127.0.0.1",
      port: 1,
      username: "jump",
      authMethod: "password",
      password: "jump-secret",
      verifyHostKeys: true,
      useSshAgent: false,
    }],
    fileProtocol: "sftp",
    identityFilePaths: [],
    hostKeyUnattended: true,
  });
  const trustedOptions = optionsFor([jumpPin]);
  const trustedEndpoint = pool.buildConnectionReuseEndpoint(trustedOptions, { sftpSudo: false });
  const ownerId = "sftp-jump-owner";
  sftpClients.set(ownerId, {
    client: {},
    sftp: {
      readable: true,
      destroyed: false,
      readdir() {},
      stat() {},
      open() {},
    },
    async end() {},
    __netcattySingleChannelSsh: true,
    __netcattyFileProtocol: "sftp",
    __netcattyEndpointKey: pool.buildEndpointKey(trustedEndpoint),
    __netcattyChannelAdoptionKey: pool.buildChannelAdoptionKey(trustedEndpoint),
    __netcattyAcceptedHostKeys: [{
      hostname: jumpPin.hostname,
      port: jumpPin.port,
      keyType: jumpPin.keyType,
      fingerprint: jumpPin.fingerprint,
    }],
  });

  const kept = await sftpBridge.openSftp(
    { sender: createSender() },
    { ...trustedOptions, sessionId: "sftp-jump-kept" },
  );
  assert.equal(sftpClients.get(kept.sftpId)?.__netcattySharedChannelAlias, true);
  assert.equal(sftpClients.get(kept.sftpId)?.__netcattySharedChannelOwnerId, ownerId);

  const revoked = sftpBridge.openSftp(
    { sender: createSender() },
    { ...optionsFor([]), sessionId: "sftp-jump-revoked" },
  );
  await assert.rejects(revoked);
  assert.equal(
    [...sftpClients.values()].filter((client) => client.__netcattySharedChannelAlias).length,
    1,
    "removing the jump pin must not borrow the channel opened through the old key",
  );
});

test("a closed single-channel SFTP stream is not borrowed (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-dead-channel" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(() => answerOtpPrompts(browseSender));
  const browse = await browseOpen;
  const browseClient = sftpClients.get(browse.sftpId);
  server.killSftpChannels();
  await waitFor(
    () => browseClient.sftp?.readable === false || browseClient.sftp?.destroyed === true,
    { timeoutMs: 4000, message: "the server SFTP close must mark the client stream dead" },
  );

  const freshSender = createSender();
  const freshOpen = sftpBridge.openSftp({ sender: freshSender }, { ...options });
  pendingOpens.push(freshOpen);
  freshOpen.catch(() => {});
  await waitFor(
    () => freshSender.sent.some((entry) => entry.channel === "netcatty:keyboard-interactive"),
    { timeoutMs: 4000, message: "a dead channel must dial again and surface OTP" },
  );
  assert.equal(
    [...sftpClients.values()].some((client) => client.__netcattySharedChannelAlias),
    false,
    "a closed SFTP stream must not be borrowed",
  );
  assert.ok(answerOtpPrompts(freshSender));
  const fresh = await freshOpen;
  assert.notEqual(fresh.sftpId, browse.sftpId);
  assert.notEqual(sftpClients.get(fresh.sftpId)?.__netcattySharedChannelAlias, true);
});

async function uploadUntilHeldWrite(t, server, transferId, targetSftpId) {
  server.holdWrites();
  const tempRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath(transferId)}-`);
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const localFile = path.join(tempRoot, "upload.txt");
  const payload = Buffer.from("borrowed upload must fail when the channel dies\n");
  fs.writeFileSync(localFile, payload);
  const transferEvents = [];
  let settled = false;
  const transferPromise = transferBridge.startTransfer(
    {
      sender: {
        send(channelName, eventPayload) {
          transferEvents.push({ channel: channelName, payload: eventPayload });
        },
      },
    },
    {
      transferId,
      sourcePath: localFile,
      targetPath: `/home/otpuser/${transferId}.txt`,
      sourceType: "local",
      targetType: "sftp",
      targetSftpId,
      targetEncoding: "utf-8",
      totalBytes: payload.length,
    },
  ).then((result) => {
    settled = true;
    return result;
  });
  await waitFor(() => server.writesHeld() > 0, {
    timeoutMs: 4000,
    message: "upload must reach a WRITE before the channel dies",
  });
  return { transferPromise, transferEvents, isSettled: () => settled };
}

async function assertBorrowedUploadFails(transferPromise, transferEvents, isSettled) {
  let hangTimer = null;
  const result = await Promise.race([
    transferPromise,
    new Promise((_, reject) => {
      hangTimer = setTimeout(() => reject(new Error("borrowed upload stayed active after the channel died")), 4000);
    }),
  ]);
  clearTimeout(hangTimer);
  assert.equal(isSettled(), true);
  assert.match(result?.error || "", /SFTP channel closed/);
  assert.ok(
    transferEvents.some((event) => (
      event.channel === "netcatty:transfer:error"
      && /SFTP channel closed/.test(String(event.payload?.error || ""))
    )),
    "the transfer error must be visible to the UI",
  );
  return result;
}

test("killing the borrowed SFTP channel mid-upload fails the transfer (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-channel-kill" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(() => answerOtpPrompts(browseSender));
  const browse = await browseOpen;
  const transfer = await sftpBridge.openSftp({ sender: createSender() }, { ...options });
  const { transferPromise, transferEvents, isSettled } = await uploadUntilHeldWrite(
    t,
    server,
    "otp-channel-kill",
    transfer.sftpId,
  );
  pendingOpens.push(transferPromise.catch(() => {}));
  server.killSftpChannels();
  await assertBorrowedUploadFails(transferPromise, transferEvents, isSettled);
});

test("a channel close with no WRITE reply still fails the borrowed upload (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-channel-close-silent" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(() => answerOtpPrompts(browseSender));
  const browse = await browseOpen;
  const transfer = await sftpBridge.openSftp({ sender: createSender() }, { ...options });
  const { transferPromise, transferEvents, isSettled } = await uploadUntilHeldWrite(
    t,
    server,
    "otp-channel-close-silent",
    transfer.sftpId,
  );
  pendingOpens.push(transferPromise.catch(() => {}));
  // The server close reaches the owner stream, but ssh2 does not always invoke
  // the outstanding WRITE. Drop those callbacks so only close/end can settle it.
  const alias = sftpClients.get(transfer.sftpId);
  const streams = [
    alias?.sftp,
    sftpClients.get(alias?.__netcattySharedChannelOwnerId || browse.sftpId)?.sftp,
  ];
  for (const stream of streams) {
    if (stream && stream._requests) stream._requests = {};
  }
  server.killSftpChannels();
  await assertBorrowedUploadFails(transferPromise, transferEvents, isSettled);
  assert.equal(
    kiHandler.getRequests().size,
    0,
    "channel death must not open a keyboard-interactive reconnect",
  );
});

test("resetting the borrowed SSH socket mid-upload fails the transfer (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-socket-reset" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(() => answerOtpPrompts(browseSender));
  const browse = await browseOpen;
  assert.ok(browse.sftpId);
  const transfer = await sftpBridge.openSftp({ sender: createSender() }, { ...options });
  const { transferPromise, transferEvents, isSettled } = await uploadUntilHeldWrite(
    t,
    server,
    "otp-socket-reset",
    transfer.sftpId,
  );
  pendingOpens.push(transferPromise.catch(() => {}));
  server.resetConnections();
  await assertBorrowedUploadFails(transferPromise, transferEvents, isSettled);
});

test("upload fails when the SFTP channel ended before WRITE subscribed (#3310)", { timeout: 20000 }, async (t) => {
  const server = await startOtpOnlyServer({ ident: "TERM-SSHD" });
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const pendingOpens = [];
  const sftpClients = new Map();
  sftpBridge.init({ sftpClients, sessions: new Map(), electronModule: {} });
  transferBridge.init({ sftpClients });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      try { await sftpBridge.closeSftp(null, { sftpId }); } catch { /* ignore */ }
    }
    for (const pending of [...kiHandler.getRequests().values()]) {
      kiHandler.cancelRequestsForSession(pending.sessionId, "test-end");
    }
    pool.discardAllTransports("test-end");
  });
  t.after(async () => {
    await server.close();
    await Promise.allSettled(pendingOpens);
  });

  const options = BASE_OPTIONS(server.port);
  const browseSender = createSender();
  const browseOpen = sftpBridge.openSftp(
    { sender: browseSender },
    { ...options, sessionId: "sftp-browse-ended-before-write" },
  );
  pendingOpens.push(browseOpen);
  browseOpen.catch(() => {});
  await waitFor(() => answerOtpPrompts(browseSender));
  const browse = await browseOpen;
  assert.ok(browse.sftpId);
  const transfer = await sftpBridge.openSftp({ sender: createSender() }, { ...options });
  const sftp = sftpClients.get(transfer.sftpId)?.sftp;
  assert.equal(typeof sftp?.open, "function");
  const origOpen = sftp.open.bind(sftp);
  const origWrite = sftp.write.bind(sftp);
  // OPEN has already succeeded. The channel then ends before WRITE installs
  // its close listener, and ssh2 will not replay end/close or answer WRITE.
  sftp.open = (filePath, flags, cb) => origOpen(filePath, flags, (err, handle) => {
    if (!err && (flags === "w" || flags === "r+")) {
      sftp.readable = false;
      sftp.destroyed = true;
    }
    cb(err, handle);
  });
  sftp.write = function writeWithoutCallback(...args) {
    if (sftp.readable === false || sftp.destroyed === true) return undefined;
    return origWrite(...args);
  };

  const tempRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("otp-ended-before-write")}-`);
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const localFile = path.join(tempRoot, "upload.txt");
  const payload = Buffer.from("ended before write subscribe\n");
  fs.writeFileSync(localFile, payload);
  const transferEvents = [];
  let settled = false;
  const transferPromise = transferBridge.startTransfer(
    {
      sender: {
        send(channelName, eventPayload) {
          transferEvents.push({ channel: channelName, payload: eventPayload });
        },
      },
    },
    {
      transferId: "otp-ended-before-write",
      sourcePath: localFile,
      targetPath: "/home/otpuser/otp-ended-before-write.txt",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: transfer.sftpId,
      targetEncoding: "utf-8",
      totalBytes: payload.length,
    },
  ).then((result) => {
    settled = true;
    return result;
  });
  pendingOpens.push(transferPromise.catch(() => {}));
  await assertBorrowedUploadFails(transferPromise, transferEvents, () => settled);
});
