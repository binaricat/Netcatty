"use strict";

// Native Windows Node + real MSYS2 OpenSSH + a disposable software SK provider.
// This deliberately does not stand in for USB/CTAP or Windows WebAuthn testing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { Client, Server, utils } = require("ssh2");
const { createAgent } = require("ssh2/lib/agent.js");
const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
const askpass = require("../electron/bridges/fidoAskpass.cjs");
const prompts = require("../electron/bridges/fidoPromptHandler.cjs");
const { generateFidoSshKeyPair } = require("../electron/bridges/fidoSshKeygen.cjs");
const { enhanceAuthOptionsForFido, prepareSystemSshAgentForAuth } = require("../electron/bridges/sshAuthHelper.cjs");
const { shutdownFidoAgentSubsystem } = require("../electron/bridges/fidoAgentManager.cjs");
const manager = require("../electron/bridges/fidoAgentManager.cjs");
const { attachFidoAgentRelease } = require("../electron/bridges/attachFidoAgentRelease.cjs");
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for software authenticator");
    await pause(25);
  }
}

test("Windows security-key integration with real user-mode OpenSSH", {
  skip: process.platform !== "win32" || process.env.NETCATTY_FIDO_WINDOWS !== "1",
  timeout: 180000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(tempDirBridge.getTempDir(), "fw-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  const originalAcquire = manager.acquireFidoAgent;
  const spacedTemp = path.join(dir, "profile space");
  fs.mkdirSync(spacedTemp);
  tempDirBridge.getTempDir = () => spacedTemp;
  const control = path.join(dir, "presence");
  const saved = Object.fromEntries(["NETCATTY_SSH_AGENT_PATH", "SSH_SK_PROVIDER", "NETCATTY_FIDO_SIM_CONTROL"].map(key => [key, process.env[key]]));
  const seen = [];
  let responsePin = "123456";
  let recoveryAction = "cancel";
  let acceptedPublicKeys = 0;
  let acceptedPasswords = 0;
  const clients = new Set();
  const authorized = new Map();
  const sender = {
    id: 2823, isDestroyed: () => false,
    send(channel, request) {
      if (channel !== "netcatty:fido-prompt-request") return;
      seen.push(request);
      if (request.notificationOnly) return;
      queueMicrotask(() => prompts.handleResponse({ sender }, {
        requestId: request.requestId,
        response: request.kind === "pin" ? responsePin : recoveryAction,
        cancelled: request.kind === "recovery" && recoveryAction === "cancel",
      }));
    },
  };
  const { privateKey: hostKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", ctx => {
      if (ctx.method === "publickey") {
        const key = authorized.get(ctx.key.data.toString("base64"));
        // ssh2's server decoder strips the first string length from signatures.
        // SK verification also needs that length, plus the untouched flags/counter.
        let signature;
        if (ctx.signature && ctx.signature.length >= 5) {
          const length = Buffer.alloc(4);
          length.writeUInt32BE(ctx.signature.length - 5);
          signature = Buffer.concat([length, ctx.signature]);
        }
        if (key && (!ctx.signature || (signature && key.verify(ctx.blob, signature, ctx.hashAlgo) === true))) {
          if (ctx.signature) acceptedPublicKeys += 1;
          return ctx.accept();
        }
      }
      if (ctx.method === "password" && ctx.password === "disposable-test-password") {
        acceptedPasswords += 1;
        return ctx.accept();
      }
      ctx.reject(["publickey", "password"]);
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", acceptExec => {
        const stream = acceptExec();
        stream.write("windows-fido-ok");
        stream.exit(0);
        stream.end();
      });
    }));
  });

  async function connect(generated, password, nativeAgent = false) {
    const options = await enhanceAuthOptionsForFido({
      hostname: "127.0.0.1", port: server.address().port, username: "netcatty",
      privateKey: generated.privateKey, identitiesOnly: true, keyLabel: "Windows test key", password,
      nativeFidoAgent: nativeAgent,
    }, sender);
    const agent = await prepareSystemSshAgentForAuth(options, "[WindowsFido]");
    assert.ok(agent, "production auth preparation must return an agent");
    const client = new Client();
    client.on("error", () => {});
    attachFidoAgentRelease(client, agent);
    const outcome = new Promise(resolve => {
      client.once("ready", () => resolve({ ready: true }));
      client.on("error", error => {
        // Ordinary agent failures allow the explicitly selected password path.
        if (error.code === "ERR_FIDO_CANCELLED" || error.level !== "agent") resolve({ error });
      });
      client.once("close", () => resolve({ error: new Error("Connection closed") }));
    });
    client.connect({ host: "127.0.0.1", port: server.address().port, username: "netcatty",
      agent: nativeAgent ? createAgent(agent._netcattyAgentSocket) : agent,
      password, authHandler: password ? ["agent", "password"] : ["agent"], readyTimeout: 15000 });
    return { client, outcome, close() { client.end(); agent._releaseNetcattyFidoAgent?.(); } };
  }

  try {
    assert.ok(process.env.NETCATTY_WINDOWS_SSH_AGENT, "Windows OpenSSH agent path is required");
    assert.ok(process.env.NETCATTY_WINDOWS_SSH_KEYGEN, "Windows OpenSSH keygen path is required");
    process.env.NETCATTY_SSH_AGENT_PATH = process.env.NETCATTY_WINDOWS_SSH_AGENT;
    manager.acquireFidoAgent = options => originalAcquire({ ...options, execFile: async (binary, args, options) => {
      try { return await run(binary, args, options); }
      catch (error) {
        // Agent startup has no secret input; surface binding errors in CI.
        console.log("[WindowsFido] agent startup rejected", args, error.stderr || error.message);
        throw error;
      }
    } });
    process.env.SSH_SK_PROVIDER = "/usr/lib/netcatty-fido-test-provider.dll";
    process.env.NETCATTY_FIDO_SIM_CONTROL = control.replace(/\\/g, "/");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    await t.test("PIN helper exchanges a response over a real Windows named pipe", async () => {
      const env = askpass.buildFidoAskpassEnv({ resolveWebContents: () => sender });
      const artifacts = askpass.ensureFidoAskpass();
      assert.match(artifacts.socketPath, /^\\\\\.\\pipe\\/);
      await pause(50);
      const result = await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c",
        `""${artifacts.wrapperPath}" "Enter PIN for authenticator:""`], {
        env: { ...process.env, ...env }, timeout: 10000, windowsHide: true,
        windowsVerbatimArguments: true,
      });
      assert.equal(result.stdout.trim(), "123456");
      askpass.releaseFidoAskpassLease(env.NETCATTY_FIDO_ASKPASS_LEASE);
    });

    for (const type of ["ED25519-SK", "ECDSA-SK"]) {
      fs.rmSync(control, { force: true });
      const generated = await generateFidoSshKeyPair({
        type, verifyRequired: true, resolveWebContents: () => sender,
        sshKeygenPath: process.env.NETCATTY_WINDOWS_SSH_KEYGEN,
      });
      assert.equal(generated.success, true, generated.error);
      const key = utils.parseKey(generated.publicKey);
      assert.ok(!(key instanceof Error), String(key));
      authorized.set(key.getPublicSSH().toString("base64"), key);

      await t.test(`${type}: PIN, physical-presence gate, signed login and command`, async () => {
        const before = seen.length;
        fs.rmSync(`${control}.waiting`, { force: true });
        fs.writeFileSync(control, "waiting");
        const connection = await connect(generated, undefined, true);
        let settled = false;
        connection.outcome.then(() => { settled = true; });
        try {
          await until(() => fs.existsSync(`${control}.waiting`));
          assert.equal(settled, false, "PIN submission alone must not finish login");
          assert.ok(seen.slice(before).some(request => request.kind === "pin"));
          fs.writeFileSync(control, "touch");
          const result = await connection.outcome;
          assert.equal(result.ready, true, result.error?.message);
          const output = await new Promise((resolve, reject) => connection.client.exec("probe", (error, stream) => {
            if (error) return reject(error);
            let text = "";
            stream.on("data", chunk => { text += chunk; });
            stream.on("close", () => resolve(text));
          }));
          assert.equal(output, "windows-fido-ok");
        } finally { connection.close(); }
      });

      for (const runtime of ["MSYS", "Win32"]) {
        await t.test(`${type}: real ${runtime} OpenSSH logs in through its native socket`, async () => {
          const sshPath = runtime === "MSYS"
            ? path.join(path.dirname(process.env.NETCATTY_WINDOWS_SSH_AGENT), "ssh.exe")
            : path.join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe");
          assert.ok(fs.existsSync(sshPath), `${runtime} SSH client must be installed`);
          const before = seen.length;
          fs.writeFileSync(control, "touch");
          const options = await enhanceAuthOptionsForFido({
            privateKey: generated.privateKey, identitiesOnly: true,
            nativeFidoAgent: true, nativeSshPath: sshPath,
          }, sender);
          const agent = await prepareSystemSshAgentForAuth(options, "[WindowsNativeFido]");
          try {
            const identityAgent = agent._netcattyAgentSocket;
            assert.equal(identityAgent.startsWith("\\\\.\\pipe"), runtime === "Win32");
            const result = await run(sshPath, ["-F", "none", "-p", String(server.address().port),
              "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL",
              "-o", "PreferredAuthentications=publickey", "-o", "BatchMode=yes",
              "-o", `IdentityAgent=${JSON.stringify(identityAgent)}`, "netcatty@127.0.0.1", "probe"],
            { env: { ...process.env, SSH_AUTH_SOCK: identityAgent }, timeout: 15000, windowsHide: true });
            assert.equal(result.stdout, "windows-fido-ok");
            assert.ok(seen.slice(before).some(request => request.kind === "pin"));
          } finally { agent._releaseNetcattyFidoAgent?.(); }
        });
      }

      for (const fallback of [false, true]) {
        await t.test(`${type}: missing device ${fallback ? "allows explicit password fallback" : "cancel never uses saved password"}`, async () => {
          const before = seen.length;
          const beforePasswords = acceptedPasswords;
          recoveryAction = fallback ? "fallback" : "cancel";
          fs.writeFileSync(control, "unplugged");
          const connection = await connect(generated, "disposable-test-password");
          try {
            const result = await connection.outcome;
            assert.equal(Boolean(result.ready), fallback);
            const recovery = seen.slice(before).find(request => request.kind === "recovery");
            assert.ok(recovery);
            assert.equal(recovery.reason, "failed", "Windows has no helper error observer yet");
            assert.equal(recovery.allowPasswordFallback, true);
            assert.equal(acceptedPasswords - beforePasswords, Number(fallback));
            if (!fallback) assert.equal(result.error?.code, "ERR_FIDO_CANCELLED");
          } finally { connection.close(); recoveryAction = "cancel"; }
        });
      }

      await t.test(`${type}: incorrect PIN cannot authenticate`, async () => {
        fs.writeFileSync(control, "touch");
        responsePin = "incorrect-test-pin";
        const connection = await connect(generated);
        try {
          const result = await connection.outcome;
          assert.equal(result.ready, undefined);
          assert.equal(result.error?.code, "ERR_FIDO_CANCELLED");
        } finally { connection.close(); responsePin = "123456"; }
      });
    }
    assert.equal(acceptedPublicKeys, 6, "server must verify both SK algorithms through ssh2, MSYS SSH, and Win32 SSH");
    assert.equal(acceptedPasswords, 2, "only explicit fallback may use a password");
  } finally {
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    shutdownFidoAgentSubsystem();
    askpass.shutdownFidoAskpass();
    tempDirBridge.getTempDir = originalGetTempDir;
    manager.acquireFidoAgent = originalAcquire;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
