"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const net = require("node:net");
const { once } = require("node:events");
const { utils } = require("ssh2");
const { createAgent } = require("ssh2/lib/agent.js");
const { createNativeFidoAgent, authenticateCygwinSocket } = require("./fidoNativeAgent.cjs");
const askpass = require("./fidoAskpass.cjs");
const prompts = require("./fidoPromptHandler.cjs");
const run = promisify(execFile);

function key() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" } });
  return utils.parseKey(pair.privateKey);
}

function sign(agent, key, data) {
  return new Promise((resolve, reject) => agent.sign(key, data, { hash: "sha256" },
    (error, signature) => error ? reject(error) : resolve(signature)));
}

test("native agent sockets attribute concurrent helper subprocess prompts to their signing windows", async () => {
  const selected = key();
  const seen = [];
  const proxies = [];
  const envs = [];
  try {
    for (const id of [2823, 2824]) {
      const sender = { id, isDestroyed: () => false, send(channel, request) {
        if (channel !== "netcatty:fido-prompt-request") return;
        seen.push(id);
        queueMicrotask(() => prompts.handleResponse({ sender }, {
          requestId: request.requestId, response: `test-pin-${id}`, cancelled: false,
        }));
      } };
      const env = askpass.buildFidoAskpassEnv({ resolveWebContents: () => sender });
      envs.push(env);
      const wrapped = {
        getIdentities: callback => callback(null, [selected]),
        sign(publicKey, data, flags, callback) {
          askpass.runWithFidoSigningLease(env.NETCATTY_FIDO_ASKPASS_LEASE, finish => {
            const { NETCATTY_FIDO_ASKPASS_LEASE: _lease, ...helperEnv } = env;
            // Real generated helper subprocess, with the shared agent's
            // leaseless environment, as OpenSSH's ssh-sk-helper would use it.
            run(process.execPath, [askpass.ensureFidoAskpass().scriptPath, "Enter PIN for authenticator:"], {
              env: { ...process.env, ...helperEnv }, timeout: 10000,
            }).then(result => {
              assert.equal(result.stdout.trim(), `test-pin-${id}`);
              finish();
              callback(null, selected.sign(data, flags.hash));
            }, error => { finish(); callback(error); });
          });
        },
      };
      proxies.push(await createNativeFidoAgent(wrapped));
    }
    const data = Buffer.from("native SSH signing request");
    const signatures = await Promise.all(proxies.map(proxy => sign(createAgent(proxy.socketPath), selected, data)));
    assert.deepEqual(seen, process.platform === "win32" ? [2823, 2823, 2824, 2824] : [2823, 2824]);
    for (const signature of signatures) assert.equal(selected.verify(data, signature, "sha256"), true);
  } finally {
    for (const proxy of proxies) proxy.close();
    for (const env of envs) askpass.releaseFidoAskpassLease(env.NETCATTY_FIDO_ASKPASS_LEASE);
    askpass.shutdownFidoAskpass();
  }
});

test("native agent rejects signing identities outside the session selection and closes on release", async () => {
  const selected = key();
  const unrelated = key();
  let signCalls = 0;
  const proxy = await createNativeFidoAgent({
    getIdentities: callback => callback(null, [selected]),
    sign: () => { signCalls += 1; },
  });
  try {
    const client = createAgent(proxy.socketPath);
    await assert.rejects(sign(client, unrelated, Buffer.from("unauthorized")), /failure/);
    assert.equal(signCalls, 0);
  } finally { proxy.close(); }
  await assert.rejects(new Promise((resolve, reject) => createAgent(proxy.socketPath).getIdentities(
    error => error ? reject(error) : resolve())), /Failed to connect to agent/);
});

test("unsupported OpenSSH extensions do not corrupt the following identity request", { timeout: 5000 }, async () => {
  const selected = key();
  const proxy = await createNativeFidoAgent({ getIdentities: callback => callback(null, [selected]) });
  const socket = net.createConnection(proxy.socketPath);
  function frame(type, payload = Buffer.alloc(0)) {
    const buffer = Buffer.alloc(5 + payload.length);
    buffer.writeUInt32BE(1 + payload.length);
    buffer[4] = type;
    payload.copy(buffer, 5);
    return buffer;
  }
  try {
    await once(socket, "connect");
    const responses = new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      const types = [];
      socket.on("error", reject);
      socket.on("data", chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 5 && buffered.length >= 4 + buffered.readUInt32BE()) {
          types.push(buffered[4]);
          buffered = buffered.subarray(4 + buffered.readUInt32BE());
        }
        if (types.length >= 3) resolve(types);
      });
    });
    // Coalesce identities, an unknown payload, and identities in one write.
    // This also proves parsing advances correctly after a preceding frame.
    socket.write(Buffer.concat([frame(11), frame(27, Buffer.from("unsupported-extension-payload")), frame(11)]));
    assert.deepEqual(await responses, [12, 5, 12]);
  } finally { socket.destroy(); proxy.close(); }
});


test("Cygwin socket authenticates fragmented handshakes and rejects a wrong secret", { timeout: 5000 }, async () => {
  const secret = randomBytes(16);
  let admitted = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    authenticateCygwinSocket(socket, secret, authenticated => {
      admitted += 1;
      authenticated.on("data", data => authenticated.write(data));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connect = () => net.createConnection(server.address().port, "127.0.0.1");
  const bad = connect();
  const good = connect();
  const goodConnected = once(good, "connect");
  try {
    await once(bad, "connect");
    const closed = once(bad, "close");
    bad.write(Buffer.alloc(16));
    await closed;
    assert.equal(admitted, 0);
    await goodConnected;
    const echo = once(good, "data");
    good.write(secret.subarray(0, 7));
    good.write(secret.subarray(7));
    assert.deepEqual((await echo)[0], secret);
    const credentials = Buffer.alloc(12);
    credentials.writeUInt32LE(1001, 4);
    credentials.writeUInt32LE(1002, 8);
    const reply = new Promise(resolve => {
      let bytes = Buffer.alloc(0);
      good.on("data", chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length >= 17) resolve(bytes);
      });
    });
    good.write(credentials.subarray(0, 5));
    // Preserve agent bytes coalesced with the end of the credential handshake.
    good.write(Buffer.concat([credentials.subarray(5), Buffer.from("agent")]));
    const bytes = await reply;
    assert.equal(bytes.readUInt32LE(0), process.pid);
    assert.deepEqual(bytes.subarray(4, 12), credentials.subarray(4));
    assert.equal(bytes.subarray(12).toString(), "agent");
    assert.equal(admitted, 1);
  } finally {
    bad.destroy(); good.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
