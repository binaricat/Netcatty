"use strict";

/**
 * Generate OpenSSH FIDO2 (sk-*) key pairs via ssh-keygen.
 *
 * Requires a platform OpenSSH build with libfido2 (e.g. Homebrew openssh on
 * macOS). The user must touch the security key (and enter a PIN when required).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");

const execFileAsync = promisify(execFile);

function resolveSshKeygenBinary(env = process.env) {
  if (typeof env.NETCATTY_SSH_KEYGEN_PATH === "string" && env.NETCATTY_SSH_KEYGEN_PATH.trim()) {
    return env.NETCATTY_SSH_KEYGEN_PATH.trim();
  }
  if (process.platform === "darwin") {
    // Prefer Homebrew OpenSSH when present (system ssh often lacks libfido2).
    for (const candidate of [
      "/opt/homebrew/bin/ssh-keygen",
      "/usr/local/bin/ssh-keygen",
      "/usr/bin/ssh-keygen",
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  return "ssh-keygen";
}

/**
 * @param {{
 *   type: "ED25519-SK" | "ECDSA-SK",
 *   comment?: string,
 *   resident?: boolean,
 *   verifyRequired?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: typeof execFileAsync,
 *   sshKeygenPath?: string,
 * }} options
 */
async function generateFidoSshKeyPair(options = {}) {
  const type = options.type === "ECDSA-SK" ? "ecdsa-sk" : "ed25519-sk";
  const comment = options.comment || "netcatty-fido-key";
  const env = options.env || process.env;
  const run = options.execFile || execFileAsync;
  const sshKeygen = options.sshKeygenPath || resolveSshKeygenBinary(env);

  let baseDir;
  try {
    const tempDirBridge = require("./tempDirBridge.cjs");
    if (typeof tempDirBridge.getTempDir !== "function") {
      return {
        success: false,
        error: "FIDO2 key generation requires Netcatty temp directory (tempDirBridge unavailable).",
      };
    }
    baseDir = tempDirBridge.getTempDir();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `FIDO2 key generation requires Netcatty temp directory: ${message}`,
    };
  }
  const tempDir = await fs.promises.mkdtemp(path.join(baseDir, "netcatty-fido-keygen-"));
  const keyPath = path.join(tempDir, `id_${type.replace(/-sk$/, "_sk")}_${randomUUID().slice(0, 8)}`);

  let askpassLeaseId = null;
  try {
    const args = [
      "-t", type,
      "-f", keyPath,
      "-C", comment,
      "-N", "", // empty passphrase on the key *handle* file (PIN is on the device)
    ];
    if (options.resident) args.push("-O", "resident");
    if (options.verifyRequired) args.push("-O", "verify-required");

    let askpassEnv = {};
    try {
      const { buildFidoAskpassEnv } = require("./fidoAskpass.cjs");
      askpassEnv = buildFidoAskpassEnv({
        resolveWebContents: options.resolveWebContents,
      });
      askpassLeaseId = askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE || null;
    } catch {
      // GUI askpass unavailable in pure unit tests
    }

    try {
      await run(sshKeygen, args, {
        timeout: 180000,
        windowsHide: true,
        env: {
          ...env,
          ...askpassEnv,
          // Force askpass so PIN/touch go through Netcatty modals (no TTY).
          SSH_ASKPASS_REQUIRE: askpassEnv.SSH_ASKPASS
            ? "force"
            : (env.SSH_ASKPASS_REQUIRE || undefined),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = error?.stderr?.toString?.() || error?.message || String(error);
      const hint = /provider|fido|sk_|feature not supported|invalid format|device not found|no such file/i.test(stderr)
        ? " Ensure OpenSSH is built with libfido2 (macOS: brew install openssh libfido2) and a FIDO2 key is plugged in."
        : "";
      return {
        success: false,
        error: `FIDO2 key generation failed: ${stderr.trim()}.${hint}`,
      };
    }

    const [privateKey, publicKey] = await Promise.all([
      fs.promises.readFile(keyPath, "utf8"),
      fs.promises.readFile(`${keyPath}.pub`, "utf8"),
    ]);

    return {
      success: true,
      privateKey,
      publicKey: publicKey.trim(),
      keyType: options.type === "ECDSA-SK" ? "ECDSA-SK" : "ED25519-SK",
    };
  } finally {
    if (askpassLeaseId) {
      try {
        require("./fidoAskpass.cjs").releaseFidoAskpassLease(askpassLeaseId);
      } catch {
        // ignore
      }
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  generateFidoSshKeyPair,
  resolveSshKeygenBinary,
};
