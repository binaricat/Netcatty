"use strict";

// Observe the OpenSSH helper's error reply before ssh-agent reduces it to a
// generic SSH_AGENT_FAILURE. Requests/signatures are forwarded unchanged and
// are never logged. Windows agents without an executable wrapper keep their
// native helper; callers then use the generic recovery message.
const fs = require("node:fs");
const path = require("node:path");

const HELPER_SCRIPT = String.raw`"use strict";
const { spawn } = require("node:child_process");
const net = require("node:net");
const child = spawn(process.env.NETCATTY_FIDO_REAL_SK_HELPER, process.argv.slice(2), {
  env: process.env, stdio: ["pipe", "pipe", "inherit"],
});
let control, response = [], size = 0, finished = false, exiting = false, exitCode = 1, connected = false;
const flush = () => {
  if (exiting || !finished) return;
  exiting = true;
  control?.destroy();
  process.stdout.end(Buffer.concat(response), () => process.exit(exitCode));
};
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.on("data", chunk => {
  size += chunk.length;
  if (size > 1024 * 1024) { child.kill(); return; }
  response.push(chunk);
});
let incoming = "";
let errorCode = null;
const report = () => {
  if (!finished) return;
  if (connected && control?.writable && !control.destroyed) {
    control.write(JSON.stringify({ phase: "result", errorCode }) + "\n");
  } else if (!control || control.destroyed) flush();
};
try {
  control = net.createConnection(process.env.NETCATTY_FIDO_ASKPASS_SOCK);
  control.on("connect", () => {
    connected = true;
    control.write(JSON.stringify({ type: "sk-helper" }) + "\n");
    report();
  });
  control.setEncoding("utf8");
  control.on("data", chunk => {
    incoming += chunk;
    let nl;
    while ((nl = incoming.indexOf("\n")) !== -1) {
      const line = incoming.slice(0, nl); incoming = incoming.slice(nl + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.cancel === true) child.kill("SIGTERM");
      if (message.ack === true) flush();
    }
  });
  control.on("error", flush);
  control.on("close", flush);
} catch { /* The native helper still works if observation is unavailable. */ }
const complete = code => {
  if (finished) return;
  finished = true; exitCode = code === 0 ? 0 : 1;
  const packet = Buffer.concat(response);
  // ssh_msg framing: length, version, reply type, positive SSH error number.
  errorCode = packet.length === 13 && packet[4] === 5 && packet.readUInt32BE(0) === 9
    && packet.readUInt32BE(5) === 0 ? packet.readUInt32BE(9) : null;
  report();
  setTimeout(flush, 1000).unref();
};
child.on("error", () => complete(1));
child.on("close", complete);
process.on("SIGTERM", () => { child.kill("SIGTERM"); complete(1); });
`;

function resolveSkHelper(sshAgentPath, env = process.env) {
  const agents = [sshAgentPath];
  try { agents.push(fs.realpathSync(sshAgentPath)); } catch { /* PATH binary */ }
  const candidates = [env.SSH_SK_HELPER];
  for (const agent of agents.filter(Boolean)) {
    candidates.push(path.resolve(path.dirname(agent), "../libexec/ssh-sk-helper"));
    candidates.push(path.resolve(path.dirname(agent), "../libexec/ssh/ssh-sk-helper"));
  }
  candidates.push("/usr/lib/openssh/ssh-sk-helper", "/usr/libexec/ssh-sk-helper", "/usr/lib/ssh/ssh-sk-helper");
  return candidates.find(candidate => {
    if (!candidate) return false;
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
}

function buildSkHelperEnv(sshAgentPath, askpassEnv, env = process.env, platform = process.platform) {
  if (platform === "win32") return {};
  const helper = resolveSkHelper(sshAgentPath, env);
  if (!helper || !askpassEnv?.SSH_ASKPASS) return {};
  const base = path.dirname(askpassEnv.SSH_ASKPASS);
  const script = path.join(base, "sk-helper.cjs");
  const wrapper = path.join(base, "sk-helper.sh");
  fs.writeFileSync(script, HELPER_SCRIPT, { mode: 0o700 });
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
  return { SSH_SK_HELPER: wrapper, NETCATTY_FIDO_REAL_SK_HELPER: helper };
}

module.exports = { buildSkHelperEnv, resolveSkHelper };
