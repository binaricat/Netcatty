"use strict";
const net = require("node:net");
const { once, EventEmitter } = require("node:events");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { Server } = require("ssh2");

async function sshForwardFixture(t, { destinationPort, rejectForward = false, stallAuth = false } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const password = randomBytes(24).toString("hex");
  const peers = new Set(), sockets = new Set(), forwarded = [];
  let sessions = 0;
  const server = new Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
    peers.add(client);
    client.on("error", () => {});
    client.on("close", () => peers.delete(client));
    client.on("authentication", (ctx) => {
      if (stallAuth) return;
      if (ctx.method === "password" && ctx.username === "fixture" && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (_accept, reject) => { sessions++; reject(); });
      client.on("tcpip", (accept, reject, info) => {
        forwarded.push({ host: info.destIP, port: info.destPort });
        if (rejectForward || info.destIP !== "127.0.0.1" || info.destPort !== destinationPort) return reject();
        const socket = net.connect(destinationPort, "127.0.0.1"); sockets.add(socket);
        socket.on("error", () => {});
        socket.once("connect", () => {
          const channel = accept();
          channel.on("error", () => {});
          channel.once("close", () => socket.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const peer of peers) peer.end();
    await new Promise((resolve) => server.close(resolve));
  });
  const sender = Object.assign(new EventEmitter(), { id: 501, send() {}, isDestroyed: () => false });
  return { sender, forwarded, peers, get sessions() { return sessions; },
    options: { hostId: "fixture-host", hostname: "127.0.0.1", port: server.address().port, username: "fixture", authMethod: "password", password,
      verifyHostKeys: false, useSshAgent: false, identityFilePaths: [], keepaliveInterval: 0 },
  };
}
module.exports = { sshForwardFixture };
