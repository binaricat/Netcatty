const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { once } = require("node:events");
const net = require("node:net");
const { Client, Server } = require("ssh2");
const { createSshPingLatencyProbe } = require("./sshPingLatency.cjs");
const { createSessionOpsApi } = require("./sessionOps.cjs");

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs1", format: "pem" });

for (const keepaliveInterval of [10000, 0]) {
  test(`stats reuse authenticated SSH and preserve forwarding (keepalive=${keepaliveInterval})`,
    { timeout: 15000 }, async (t) => {
      let connections = 0;
      let authenticated = 0;
      let pings = 0;
      const peers = new Set();
      const server = new Server({ hostKeys: [hostKey] }, (peer) => {
        peers.add(peer);
        peer.on("close", () => peers.delete(peer));
        peer.on("error", () => {}); // The baseline raw probe closes before handshake.
        const handlers = peer._protocol._handlers;
        const original = handlers.GLOBAL_REQUEST;
        handlers.GLOBAL_REQUEST = (protocol, name, wantReply, data) => {
          if (name === "keepalive@openssh.com") {
            pings++;
            // Model a router that silently ignores keepalive packets.
            if (keepaliveInterval === 0) return;
          }
          original(protocol, name, wantReply, data);
        };
        peer.on("authentication", (ctx) => ctx.accept());
        peer.on("ready", () => {
          authenticated++;
          peer.on("request", (accept, reject, name) => {
            if (name === "tcpip-forward") accept(43210);
            else if (name === "cancel-tcpip-forward") accept();
            else reject();
          });
          peer.on("session", (accept) => {
            accept().on("exec", (acceptExec) => {
              const stream = acceptExec();
              stream.exit(0);
              stream.end("NC_LATENCY_MARK|CPU:5|CORES:2|MEMINFO:8000 4000 100 900 0 0|DISKS:|NET:");
            });
          });
        });
      });
      server._srv.on("connection", () => { connections++; });
      const conn = new Client();
      t.after(async () => {
        conn.destroy();
        for (const peer of peers) peer.end();
        await new Promise((resolve) => server.close(resolve));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      // Reproduce the old probe: a second connection with no authentication.
      const raw = net.connect(port, "127.0.0.1");
      await once(raw, "connect");
      raw.destroy();
      await once(raw, "close");
      conn.connect({ host: "127.0.0.1", port, username: "test", keepaliveInterval });
      await once(conn, "ready");
      const baseline = connections;
      assert.equal(baseline, 2);
      assert.equal(authenticated, 1);
      const sessions = new Map([["sid", { type: "ssh", conn }]]);
      const api = createSessionOpsApi({
        sessions, setTimeout, clearTimeout, Buffer,
        quoteShellArg: (value) => "'" + value.replace(/'/g, "'\\''") + "'",
        measureSshPingLatency: createSshPingLatencyProbe(),
      });
      for (let i = 0; i < 3; i++) {
        const [stats, forwardPort] = await Promise.all([
          api.getServerStats({}, { sessionId: "sid" }),
          new Promise((resolve, reject) => conn.forwardIn("127.0.0.1", 0,
            (err, value) => err ? reject(err) : resolve(value))),
        ]);
        assert.equal(stats.success, true);
        assert.equal(forwardPort, 43210);
        if (keepaliveInterval > 0) assert.equal(Number.isFinite(stats.stats.latencyMs), true);
        else assert.equal(stats.stats.latencyMs, null);
        await new Promise((resolve, reject) => conn.unforwardIn("127.0.0.1", forwardPort,
          (err) => err ? reject(err) : resolve()));
      }
      assert.equal(connections, baseline, "stats must not create unauthenticated connections");
      assert.equal(authenticated, 1);
      assert.equal(pings, keepaliveInterval > 0 ? 3 : 0);
      assert.equal(conn._callbacks.length, 0);
    });
}
