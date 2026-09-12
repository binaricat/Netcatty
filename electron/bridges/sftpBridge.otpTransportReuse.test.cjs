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
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const tempDirBridge = require("./tempDirBridge.cjs");

const { Server } = require("ssh2");
const keygen = require("ssh2/lib/keygen.js");

const pool = require("./sshConnectionPool.cjs");
const kiHandler = require("./keyboardInteractiveHandler.cjs");
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
function makeSftpHandlers(files, dirs) {
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

function startOtpOnlyServer() {
  return new Promise((resolve, reject) => {
    keygen.generateKeyPair("ed25519", (err, keys) => {
      if (err) return reject(err);
      const files = new Map();
      const dirs = new Set(["/", "/home", "/home/otpuser"]);
      const handlers = makeSftpHandlers(files, dirs);
      let keyboardInteractiveRounds = 0;

      const sshServer = new Server({ hostKeys: [keys.private] }, (client) => {
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
        close: () => new Promise((done) => {
          // Include clients still waiting for authentication, before registration.
          for (const socket of sockets) socket.destroy();
          sshServer.close?.();
          server.close(() => done());
        }),
      }));
    });
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
