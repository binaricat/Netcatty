"use strict";

// Native OpenSSH clients must sign through the same caller-bound agent wrapper
// as ssh2. A raw singleton socket cannot attribute a request to its window.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID, randomBytes, timingSafeEqual } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { isWindowsPosixSsh } = require("./fidoAskpass.cjs");
const { AgentProtocol } = require("ssh2/lib/agent.js");

// MSYS/Cygwin emulate AF_UNIX with an authenticated loopback connection.
// Match their secret + peer-credential handshake; never expose agent protocol
// until the caller proves it can read the private socket descriptor file.
function authenticateCygwinSocket(socket, secret, onAuthenticated) {
  let buffered = Buffer.alloc(0);
  let haveSecret = false;
  socket.setTimeout(5000, () => socket.destroy());
  function receive(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    if (!haveSecret) {
      if (buffered.length < 16) return;
      if (!timingSafeEqual(buffered.subarray(0, 16), secret)) { socket.destroy(); return; }
      buffered = buffered.subarray(16);
      haveSecret = true;
      socket.write(secret);
    }
    if (buffered.length < 12) return;
    const credentials = Buffer.from(buffered.subarray(0, 12));
    credentials.writeUInt32LE(process.pid, 0);
    socket.write(credentials);
    socket.removeListener("data", receive);
    socket.setTimeout(0);
    if (buffered.length > 12) socket.unshift(buffered.subarray(12));
    onAuthenticated(socket);
  }
  socket.on("data", receive);
}

async function createNativeFidoAgent(agent, options = {}) {
  const base = require("./tempDirBridge.cjs").getTempDir();
  const dir = await fs.promises.mkdtemp(path.join(base, "fn-"));
  const cygwin = isWindowsPosixSsh(options.sshBinaryPath);
  const secret = cygwin ? randomBytes(16) : null;
  const socketPath = process.platform === "win32" && !cygwin
    ? `\\\\.\\pipe\\netcatty-fido-native-${randomUUID()}`
    : path.join(dir, "agent.sock");
  const sockets = new Set();
  let closed = false;
  function serve(socket) {
    const protocol = new AgentProtocol(false);
    protocol.on("error", () => socket.destroy());
    const respond = operation => {
      if (!closed && !socket.destroyed && !protocol.destroyed) {
        try { operation(); } catch { socket.destroy(); }
      }
    };
    protocol.on("identities", request => {
      agent.getIdentities((error, keys) => respond(() => error
        ? protocol.failureReply(request) : protocol.getIdentitiesReply(request, keys)));
    });
    protocol.on("sign", (request, key, data, flags) => {
      // Enforce the selected identities for direct native signing requests too.
      agent.getIdentities((error, keys) => {
        if (closed || socket.destroyed) return;
        if (error || !Array.isArray(keys)
            || !keys.some(candidate => candidate.getPublicSSH().equals(key.getPublicSSH()))) {
          respond(() => protocol.failureReply(request));
          return;
        }
        agent.sign(key, data, flags, (signError, signature) => respond(() => signError
          ? protocol.failureReply(request) : protocol.signReply(request, signature)));
      });
    });
    socket.pipe(protocol).pipe(socket);
  }
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (cygwin) authenticateCygwinSocket(socket, secret, serve);
    else serve(socket);
  });
  function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}));
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      const address = cygwin ? { host: "127.0.0.1", port: 0 } : socketPath;
      server.listen(address, () => { server.removeListener("error", reject); resolve(); });
    });
    if (cygwin) {
      const words = Array.from({ length: 4 }, (_, i) => secret.readUInt32LE(i * 4).toString(16).toUpperCase().padStart(8, "0"));
      await fs.promises.writeFile(socketPath, `!<socket >${server.address().port} s ${words.join("-")}\0`, { mode: 0o600, flag: "wx" });
      // The SYSTEM attribute makes MSYS recognize the descriptor as a socket.
      await promisify(execFile)(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "attrib.exe"),
        ["+S", socketPath], { windowsHide: true, timeout: 5000 });
    }
    if (process.platform !== "win32") await fs.promises.chmod(socketPath, 0o600);
    server.on("error", close);
    return { socketPath: cygwin ? socketPath.replace(/\\/g, "/") : socketPath, close };
  } catch (error) {
    close();
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { createNativeFidoAgent, authenticateCygwinSocket };
