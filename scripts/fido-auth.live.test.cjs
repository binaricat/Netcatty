"use strict";

// Opt in with NETCATTY_FIDO_SIM=1. Uses a disposable SOFTWARE authenticator,
// real OpenSSH keygen/agent/sk-helper/sshd and Netcatty's production auth helpers.
// Requires Linux, a C compiler, OpenSSL headers and OpenSSH client/server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFileSync, execFile, spawn } = require("node:child_process");
const execFileAsync = require("node:util").promisify(execFile);
const { once } = require("node:events");
const { Client } = require("ssh2");
const { generateFidoSshKeyPair } = require("../electron/bridges/fidoSshKeygen.cjs");
const { enhanceAuthOptionsForFido, prepareSystemSshAgentForAuth } = require("../electron/bridges/sshAuthHelper.cjs");
const { shutdownFidoAgentSubsystem } = require("../electron/bridges/fidoAgentManager.cjs");
const prompts = require("../electron/bridges/fidoPromptHandler.cjs");
const askpass = require("../electron/bridges/fidoAskpass.cjs");
const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) return reject(error);
      let output = "";
      channel.on("data", (chunk) => { output += chunk; });
      channel.on("error", reject);
      channel.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`exec exit ${code}`)));
    });
  });
}

test("software FIDO authenticator authenticates against real OpenSSH", {
  skip: process.env.NETCATTY_FIDO_SIM !== "1",
  timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(tempDirBridge.getTempDir(), "fs-"));
  const provider = path.join(dir, "provider.so");
  const wrapper = path.join(dir, "ssh-agent");
  const originalEnv = {
    SSH_SK_PROVIDER: process.env.SSH_SK_PROVIDER,
    NETCATTY_SSH_AGENT_PATH: process.env.NETCATTY_SSH_AGENT_PATH,
  };
  let daemon;
  let serverLog = "";
  const receivedPrompts = [];
  const routedPrompts = [];
  const sender = {
    id: 2823, isDestroyed: () => false,
    send(channel, request) {
      if (channel !== "netcatty:fido-prompt-request") return;
      receivedPrompts.push(request.kind);
      routedPrompts.push(sender.id);
      console.log("[FidoSimulation] prompt", request.kind, request.message);
      queueMicrotask(() => prompts.handleResponse({ sender }, {
        requestId: request.requestId,
        response: request.kind === "pin" ? "123456" : "",
        cancelled: false,
      }));
    },
  };
  try {
    execFileSync("cc", ["-shared", "-fPIC", "-DHAVE_STDINT_H",
      path.join(__dirname, "fixtures/fido/provider.c"), "-lcrypto", "-o", provider]);
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/ssh-agent -P '${provider}' "$@"\n`, { mode: 0o700 });
    process.env.SSH_SK_PROVIDER = provider;
    process.env.NETCATTY_SSH_AGENT_PATH = wrapper;
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path.join(dir, "host")]);
    const port = await freePort();
    const authorizedKeys = path.join(dir, "authorized_keys");
    fs.writeFileSync(authorizedKeys, "");
    const config = path.join(dir, "sshd_config");
    fs.writeFileSync(config, [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${dir}/host`,
      `AuthorizedKeysFile ${authorizedKeys}`, `PidFile ${dir}/sshd.pid`,
      "StrictModes no", "UsePAM no", "PasswordAuthentication no",
      "KbdInteractiveAuthentication no", "LogLevel VERBOSE", "Subsystem sftp internal-sftp",
    ].join("\n") + "\n");
    daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sshd start timeout: ${serverLog}`)), 5000);
      daemon.once("error", reject);
      daemon.once("exit", (code) => { clearTimeout(timer); reject(new Error(`sshd exit ${code}: ${serverLog}`)); });
      daemon.stderr.on("data", (chunk) => {
        serverLog += chunk;
        if (serverLog.includes("Server listening")) { clearTimeout(timer); resolve(); }
      });
    });

    for (const type of ["ED25519-SK", "ECDSA-SK"]) {
      await t.test(`${type}: generation, PIN/touch, tokenized reference, SSH exec, SFTP`, async () => {
        const beforePins = receivedPrompts.filter((kind) => kind === "pin").length;
        const generated = await generateFidoSshKeyPair({
          type, verifyRequired: true, resident: true, resolveWebContents: () => sender,
        });
        assert.equal(generated.success, true, generated.error);
        assert.equal(generated.keyType, type);
        fs.appendFileSync(authorizedKeys, `verify-required ${generated.publicKey}\n`);
        const username = require("node:os").userInfo().username;
        const keyPath = path.join(dir, `id_${username}_${type}`);
        fs.writeFileSync(keyPath, generated.privateKey, { mode: 0o600 });
        fs.writeFileSync(`${keyPath}.pub`, generated.publicKey);
        // Sign a user certificate with a disposable CA and require that
        // certificate on the server for the second connection below.
        execFileSync("ssh-keygen", ["-s", path.join(dir, "host"), "-I", "fido-sim",
          "-n", username, "-V", "-1m:+5m", "-O", "verify-required", `${keyPath}.pub`]);
        const certificate = fs.readFileSync(`${keyPath}-cert.pub`, "utf8").trim();
        // A selected SK handle remains usable without its optional .pub file.
        fs.unlinkSync(`${keyPath}.pub`);
        // Probe must use the same %r expansion as ssh-add, before deciding agent auth.
        const options = await enhanceAuthOptionsForFido({
          hostname: "127.0.0.1", port, username, useSshAgent: false,
          identityFilePaths: [path.join(dir, `id_%r_${type}`)], identitiesOnly: true,
        }, sender);
        assert.equal(options.useFidoAgent, true);
        const agent = await prepareSystemSshAgentForAuth(options, "[FidoSimulation]");
        assert.ok(agent);
        const client = new Client();
        try {
          client.connect({ host: options.hostname, port, username, agent, readyTimeout: 15000 });
          await once(client, "ready");
          assert.equal(await exec(client, "printf netcatty-fido-ok"), "netcatty-fido-ok");
          const sftp = await new Promise((resolve, reject) => client.sftp((error, session) => error ? reject(error) : resolve(session)));
          const stat = await new Promise((resolve, reject) => sftp.stat(authorizedKeys, (error, value) => error ? reject(error) : resolve(value)));
          assert.ok(stat.size > 0);
          sftp.end();
          const echo = net.createServer((socket) => socket.pipe(socket));
          echo.listen(0, "127.0.0.1");
          await once(echo, "listening");
          try {
            const stream = await new Promise((resolve, reject) => client.forwardOut(
              "127.0.0.1", 12345, "127.0.0.1", echo.address().port,
              (error, channel) => error ? reject(error) : resolve(channel),
            ));
            const data = once(stream, "data");
            stream.write("fido-forward-ok");
            assert.equal(String((await data)[0]), "fido-forward-ok");
            stream.end();
          } finally { await new Promise((resolve) => echo.close(resolve)); }
          // A signing PIN prompt must have crossed helper subprocess -> socket -> IPC.
          assert.ok(receivedPrompts.filter((kind) => kind === "pin").length >= beforePins + 2);
          const otherSender = {
            id: 2824, isDestroyed: () => false,
            send(channel, request) {
              if (channel !== "netcatty:fido-prompt-request") return;
              routedPrompts.push(otherSender.id);
              queueMicrotask(() => prompts.handleResponse({ sender: otherSender }, {
                requestId: request.requestId, response: "123456", cancelled: false,
              }));
            },
          };
          const otherAgent = await prepareSystemSshAgentForAuth({
            ...options, resolveWebContents: () => otherSender,
          }, "[FidoSecondWindow]");
          const pair = [new Client(), new Client()];
          try {
            const beforeRouting = routedPrompts.length;
            await Promise.all(pair.map(async (connection, index) => {
              connection.connect({ host: options.hostname, port, username,
                agent: index ? otherAgent : agent, readyTimeout: 15000 });
              await once(connection, "ready");
              assert.equal(await exec(connection, "printf multi-window-ok"), "multi-window-ok");
            }));
            assert.deepEqual(new Set(routedPrompts.slice(beforeRouting)), new Set([sender.id, otherSender.id]));
            const nativeAgents = await Promise.all([sender, otherSender].map(owner => prepareSystemSshAgentForAuth({
              ...options, nativeFidoAgent: true, resolveWebContents: () => owner,
            }, "[NativeFidoWindow]")));
            try {
              const beforeNative = routedPrompts.length;
              const results = await Promise.all(nativeAgents.map(nativeAgent => execFileAsync("ssh", [
                "-o", `IdentityAgent=${nativeAgent._netcattyAgentSocket}`,
                "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "CertificateFile=none",
                "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                "-i", keyPath, "-p", String(port), `${username}@127.0.0.1`, "printf native-fido-ok",
              ], { timeout: 15000 })));
              for (const result of results) assert.equal(result.stdout, "native-fido-ok");
              assert.deepEqual(new Set(routedPrompts.slice(beforeNative)), new Set([sender.id, otherSender.id]));
            } finally { nativeAgents.forEach(nativeAgent => nativeAgent._releaseNetcattyFidoAgent?.()); }
            // A second certificate for an owned bare key needs its own hold.
            // Closing it must remove that certificate and retain the first.
            const extraPubPath = path.join(dir, `${type}-extra.pub`);
            fs.writeFileSync(extraPubPath, generated.publicKey);
            execFileSync("ssh-keygen", ["-s", path.join(dir, "host"), "-I", "fido-extra", "-z", "2",
              "-n", username, "-V", "-1m:+5m", "-O", "verify-required", extraPubPath]);
            const extraCertificate = fs.readFileSync(extraPubPath.replace(/\.pub$/, "-cert.pub"), "utf8").trim();
            const extraAgent = await prepareSystemSshAgentForAuth({
              ...options, privateKey: generated.privateKey, identityFilePaths: [], certificate: extraCertificate,
            }, "[ExtraFidoCertificate]");
            const sharedSocket = require("../electron/bridges/fidoAgentManager.cjs").getActiveFidoAgentSocket();
            extraAgent._releaseNetcattyFidoAgent();
            await require("../electron/bridges/systemSshAgent.cjs").withAgentIdentityLock(sharedSocket, async () => {});
            const remaining = (await execFileAsync("ssh-add", ["-L"], {
              env: { ...process.env, SSH_AUTH_SOCK: sharedSocket },
            })).stdout;
            assert.ok(remaining.includes(generated.publicKey.split(" ")[1]), "bare identity remains in use");
            assert.ok(remaining.includes(certificate.split(" ")[1]), "other session's certificate remains in use");
            assert.ok(!remaining.includes(extraCertificate.split(" ")[1]), "released certificate is removed");
          } finally {
            pair.forEach((connection) => connection.end());
            otherAgent._releaseNetcattyFidoAgent?.();
          }
        } finally {
          client.end();
          agent._releaseNetcattyFidoAgent?.();
        }
        fs.writeFileSync(authorizedKeys,
          `cert-authority,verify-required,principals="${username}" ${fs.readFileSync(path.join(dir, "host.pub"), "utf8")}`);
        const certAgent = await prepareSystemSshAgentForAuth({
          ...options, certificate, nativeFidoAgent: true,
          ...(type === "ECDSA-SK" ? { privateKey: generated.privateKey, identityFilePaths: [] } : {}),
        }, "[FidoCertificateSimulation]");
        const certClient = new Client();
        try {
          certClient.connect({ host: options.hostname, port, username, agent: certAgent, readyTimeout: 15000 });
          await once(certClient, "ready");
          assert.equal(await exec(certClient, "printf fido-cert-ok"), "fido-cert-ok");
          const nativeCertificate = await execFileAsync("ssh", [
            "-o", `IdentityAgent=${certAgent._netcattyAgentSocket}`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", `CertificateFile=${keyPath}-cert.pub`, "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null", "-i", keyPath, "-p", String(port),
            `${username}@127.0.0.1`, "printf native-cert-ok",
          ], { timeout: 15000 });
          assert.equal(nativeCertificate.stdout, "native-cert-ok");
        } finally {
          certClient.end();
          certAgent._releaseNetcattyFidoAgent?.();
          fs.writeFileSync(authorizedKeys, "");
        }
      });
    }
    assert.match(serverLog, /Accepted publickey/);
    assert.ok(receivedPrompts.includes("pin"));
  } catch (error) {
    error.message += `\nOpenSSH server log:\n${serverLog}`;
    throw error;
  } finally {
    daemon?.kill();
    shutdownFidoAgentSubsystem();
    askpass.shutdownFidoAskpass();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
