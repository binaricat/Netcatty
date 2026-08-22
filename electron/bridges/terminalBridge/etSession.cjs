/* eslint-disable no-undef */
const crypto = require("node:crypto");
const { createSystemKnownHostsApi } = require("../sshBridge/systemKnownHosts.cjs");
const {
  buildAuthoritativeKnownHostsContent,
  buildExternalHostKeyConfigLines,
  buildExternalHostKeySshOptions,
  vaultPinsConnectionHosts,
} = require("../externalSshHostKeyPolicy.cjs");
const { emitTerminalSessionData } = require("../emitTerminalSessionData.cjs");
const {
  setBufferedOutputBytes,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
} = require("../terminalFlowAck.cjs");
const { orderSshIdentityNames, SSH_KEY_PATTERN } = require("../sshAuthHelper.cjs");
const { fanoutSessionExit } = require("../terminalAttachRestore.cjs");

//
// EternalTerminal session backend, factored into the createXxxSessionApi
// pattern used by moshSession.cjs / telnetSession.cjs. Dependencies arrive
// via `ctx`; `with (ctx)` exposes them as free identifiers.
//
// Unlike Mosh, the `et` client performs its own SSH bootstrap and ET protocol
// handshake — Netcatty just spawns the bundled `et` binary as a PTY. Saved
// credentials (password / passphrase / jump host) are injected into et's
// internal ssh via a private ~/.ssh home + SSH_ASKPASS helper, since et drives
// ssh itself rather than exposing the prompts for us to type into.
function createEtSessionApi(ctx) {
  with (ctx) {
    // Node script invoked by ssh as SSH_ASKPASS. It reads the prompt text from
    // argv, matches it against the entries in NETCATTY_ET_ASKPASS_MAP, and
    // prints the matching secret. Written to the session's private .ssh dir.
    const ET_ASKPASS_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function normalizePrompt(prompt) {
  return String(prompt || "").toLowerCase();
}

function loadEntries() {
  const mapPath = process.env.NETCATTY_ET_ASKPASS_MAP;
  if (!mapPath) return [];
  try {
    const raw = fs.readFileSync(mapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function matchesPrompt(entry, prompt) {
  const matchers = Array.isArray(entry.matchers) ? entry.matchers : [];
  return matchers.some((matcher) => prompt.includes(String(matcher || "").toLowerCase()));
}

function promptMatchScore(entry, prompt) {
  const matchers = Array.isArray(entry.matchers) ? entry.matchers : [];
  let score = 0;
  for (const matcher of matchers) {
    const value = String(matcher || "").toLowerCase();
    if (value && prompt.includes(value)) score = Math.max(score, value.length);
  }
  return score;
}

function pickEntry(entries, prompt) {
  const wantsPassphrase = prompt.includes("passphrase");
  const matchesKnownLoginPrompt = entries.some((entry) => entry.type === "password"
    && (Array.isArray(entry.matchers) ? entry.matchers : []).some((matcher) => {
      const value = String(matcher || "").toLowerCase();
      return value.endsWith("'s password") && prompt.includes(value);
    }));
  const wantsSecondFactor = !matchesKnownLoginPrompt
    && /one[\s-]?time|\botp\b|verification|passcode|\btoken\b|2fa|two[\s-]?factor|multi[\s-]?factor|\bmfa\b|second\s+factor|secondary(?:\s+\w+){0,3}\s+passw|second(?:\s+\w+){0,3}\s+passw|additional(?:\s+\w+){0,3}\s+passw|re[-\s]?enter\s+passw|confirm\s+passw|\bedr\b|duo|动态|一次性|验证码|验证信息|令牌|双因素|多因素|短信验证|手机验证|二次|安全密码|挑战码/.test(prompt);
  const wantsPassword = !wantsSecondFactor && /passw(or)?d|密\s*码|口\s*令/.test(prompt);
  if (!wantsPassphrase && !wantsPassword) return null;
  const scoped = entries.filter((entry) => entry.type === (wantsPassphrase ? "passphrase" : "password"));
  const matched = scoped
    .map((entry, index) => ({ entry, index, score: promptMatchScore(entry, prompt) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.entry;
  if (matched) return matched;
  if (wantsPassword && scoped.length === 1) return scoped[0];
  return null;
}

function main() {
  const prompt = normalizePrompt(process.argv.slice(2).join(" "));
  const entries = loadEntries();
  const entry = pickEntry(entries, prompt);
  if (!entry?.secretFile) return;
  try {
    const secret = fs.readFileSync(entry.secretFile, "utf8").replace(/\r?\n$/, "");
    process.stdout.write(secret + "\n");
  } catch {
    // ignore
  }
}

main();
`;

    /**
     * Resolve Netcatty's bundled `et` client. System `et` installs are
     * intentionally ignored so dev, CI, and release builds exercise the same
     * binary (mirrors resolveBareMoshClient).
     */
    function resolveBareEtClient(opts = {}) {
      return bundledEtClient(opts);
    }

    function writeSecureFile(filePath, content, mode = 0o600) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, typeof content === "string" ? "utf8" : undefined);
      if (process.platform === "win32") {
        try {
          // Remove inherited ACLs, grant only current user full control
          execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`], {
            windowsHide: true,
            timeout: 5000,
          });
        } catch {
          // ignore ACL failures (e.g. network drives)
        }
      } else {
        try {
          fs.chmodSync(filePath, mode);
        } catch {
          // ignore chmod failures on non-POSIX filesystems
        }
      }
      return filePath;
    }

    function normalizeSshConfigPath(targetPath) {
      const raw = String(targetPath);
      const expanded = raw === "~"
        ? os.homedir()
        : raw.startsWith("~/") || raw.startsWith("~\\")
          ? path.join(os.homedir(), raw.slice(2))
          : raw;
      return path.resolve(expanded).replace(/\\/g, "/");
    }

    function quoteSshConfigValue(value) {
      const normalized = normalizeSshConfigPath(value);
      return `"${normalized.replace(/(["\\])/g, "\\$1")}"`;
    }

    function quoteRawSshConfigValue(value) {
      return `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
    }

    function publicIdentitySelectorPath(value) {
      const raw = String(value);
      return raw.toLowerCase().endsWith(".pub") ? raw : `${raw}.pub`;
    }

    async function prepareEtSshAgentOptions(options, sender) {
      const {
        enhanceAuthOptionsForFido,
        resolvePreparedAgentSocket,
      } = require("../sshAuthHelper.cjs");
      const prepareOne = async (connectionOptions, logPrefix) => {
        const prepOptions = await enhanceAuthOptionsForFido(connectionOptions, sender);
        const forceFido = prepOptions.useFidoAgent === true
          && connectionOptions.authMethod !== "password";
        if (connectionOptions?.useSshAgent !== true && !connectionOptions?.agentForwarding && !forceFido) {
          return connectionOptions;
        }
        let prepared = connectionOptions;
        /** @type {(() => void)|null} */
        let releasePreparedAgent = null;
        try {
          if (connectionOptions.useSshAgent === true || forceFido) {
            const agent = await prepareSystemSshAgentForAuth(prepOptions, logPrefix);
            if (typeof agent?._releaseNetcattyFidoAgent === "function") {
              releasePreparedAgent = agent._releaseNetcattyFidoAgent;
            }
            const socketPath = resolvePreparedAgentSocket(agent, prepOptions)
              || await getAvailableAgentSocket(connectionOptions.identityAgent, connectionOptions);
            if (!socketPath) {
              throw new Error(
                forceFido
                  ? "FIDO2 SSH agent is unavailable. Install OpenSSH with libfido2 and try again."
                  : "System SSH agent is unavailable. Start or unlock it, or configure a valid agent socket.",
              );
            }
            prepared = {
              ...prepared,
              useSshAgent: true,
              _resolvedSshAgentSocket: socketPath,
              ...(releasePreparedAgent
                ? { _releaseNetcattyFidoAgent: releasePreparedAgent }
                : {}),
            };
          }
          if (connectionOptions.agentForwarding) {
            // May throw (e.g. Windows Pageant/Cygwin rejected for native OpenSSH).
            // Release this hop's already-acquired FIDO agent/askpass lease before
            // rethrowing — preparedEntries only sees hops that return successfully.
            const forwardingSocketPath = await getAvailableForwardingAgentSocket(
              connectionOptions.identityAgent,
              connectionOptions,
            );
            if (forwardingSocketPath) {
              prepared = { ...prepared, _resolvedForwardingAgentSocket: forwardingSocketPath };
            }
          }
          return prepared;
        } catch (error) {
          if (typeof releasePreparedAgent === "function") {
            try { releasePreparedAgent(); } catch { /* ignore */ }
          }
          throw error;
        }
      };

      // Track successfully prepared hops so a later prepareOne failure can release
      // earlier FIDO agent/askpass leases (caller still has the no-op release).
      const preparedEntries = [];
      const releasePreparedEntries = () => {
        const seen = new Set();
        for (const entry of preparedEntries) {
          const releaseFn = entry?._releaseNetcattyFidoAgent;
          if (typeof releaseFn !== "function" || seen.has(releaseFn)) continue;
          seen.add(releaseFn);
          try { releaseFn(); } catch { /* ignore */ }
        }
      };

      try {
        const preparedTarget = await prepareOne(options, "[ET]");
        preparedEntries.push(preparedTarget);
        if (!Array.isArray(options.jumpHosts) || options.jumpHosts.length === 0) {
          return preparedTarget;
        }
        const preparedJumpHosts = [];
        for (let index = 0; index < options.jumpHosts.length; index += 1) {
          const preparedJump = await prepareOne(
            options.jumpHosts[index],
            `[ET Chain] Hop ${index + 1}:`,
          );
          preparedEntries.push(preparedJump);
          preparedJumpHosts.push(preparedJump);
        }
        return { ...preparedTarget, jumpHosts: preparedJumpHosts };
      } catch (error) {
        releasePreparedEntries();
        throw error;
      }
    }

    function collectEtFidoAgentReleases(options) {
      const releases = [];
      if (typeof options?._releaseNetcattyFidoAgent === "function") {
        releases.push(options._releaseNetcattyFidoAgent);
      }
      for (const jump of options?.jumpHosts || []) {
        if (typeof jump?._releaseNetcattyFidoAgent === "function") {
          releases.push(jump._releaseNetcattyFidoAgent);
        }
      }
      return releases;
    }

    function createOneShotEtFidoAgentReleases(options) {
      const pending = collectEtFidoAgentReleases(options);
      if (pending.length === 0) return () => {};
      const seen = new Set();
      return () => {
        for (const releaseFn of pending) {
          if (seen.has(releaseFn)) continue;
          seen.add(releaseFn);
          try { releaseFn(); } catch { /* ignore */ }
        }
      };
    }

    function applyEtSshAgentEnvironment(env, options) {
      delete env.SSH_AUTH_SOCK;
      if (options?.useSshAgent === false) {
        const automaticJumpNeedsAmbientAgent = options.jumpHosts?.some((jump) => (
          jump?.authMethod === "auto" && jump.useSshAgent !== false
        ));
        if (automaticJumpNeedsAmbientAgent && process.env.SSH_AUTH_SOCK) {
          env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
        }
        return env;
      }
      const socketPath = options?._resolvedSshAgentSocket || process.env.SSH_AUTH_SOCK;
      if (socketPath) env.SSH_AUTH_SOCK = socketPath;
      return env;
    }

    // POSIX single-quote a string so it is safe to embed verbatim in a /bin/sh
    // script (handles spaces and embedded single quotes in e.g. an .app path).
    function shellSingleQuote(value) {
      return `'${String(value).replace(/'/g, "'\\''")}'`;
    }

    function createPasswordPromptMatchers({ hostname, username, port }) {
      const values = new Set();
      const addHostVariant = (hostValue) => {
        if (!hostValue) return;
        const lowerHost = String(hostValue).toLowerCase();
        values.add(lowerHost);
        if (username) {
          values.add(`${String(username).toLowerCase()}@${lowerHost}`);
          values.add(`${String(username).toLowerCase()}@${lowerHost}'s password`);
          if (port) values.add(`${String(username).toLowerCase()}@${lowerHost}:${port}`);
        }
      };

      addHostVariant(hostname);
      return [...values];
    }

    function createPassphrasePromptMatchers(keyPath) {
      const normalizedPath = normalizeSshConfigPath(keyPath).toLowerCase();
      return [normalizedPath, path.basename(normalizedPath)];
    }

    function addAskpassEntry(entries, type, matchers, secretFile) {
      if (!secretFile) return;
      entries.push({
        type,
        matchers: [...new Set((matchers || []).map((value) => String(value || "").toLowerCase()).filter(Boolean))],
        secretFile,
      });
    }

    // ET's internal ssh is driven through SSH_ASKPASS, so secondary-factor
    // prompts cannot be routed to Netcatty's renderer modal from this path.
    function buildPreferredAuthentications({ authMethod, hasPassword = false, hasPublicKey = false }) {
      if (authMethod === "password") {
        return "password,keyboard-interactive";
      }
      if (authMethod === "auto") {
        return "publickey,password,keyboard-interactive";
      }
      if (hasPublicKey) {
        return hasPassword ? "publickey,password,keyboard-interactive" : "publickey";
      }
      if (hasPassword) {
        return "password,keyboard-interactive";
      }
      return "";
    }

    function createEtAskpassArtifacts(sshDir, askpassEntries) {
      if (!Array.isArray(askpassEntries) || askpassEntries.length === 0) {
        return { env: {}, artifacts: [] };
      }

      const askpassMapPath = path.join(sshDir, "netcatty-et-askpass-map.json");
      const askpassScriptPath = path.join(sshDir, "netcatty-et-askpass.cjs");
      writeSecureFile(askpassMapPath, `${JSON.stringify(askpassEntries, null, 2)}\n`, 0o600);
      writeSecureFile(askpassScriptPath, ET_ASKPASS_SCRIPT, 0o700);

      if (process.platform === "win32") {
        const askpassCmdPath = path.join(sshDir, "netcatty-et-askpass.cmd");
        writeSecureFile(
          askpassCmdPath,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath.replace(/"/g, '""')}" "%~dp0netcatty-et-askpass.cjs" %*\r\n`,
          0o700,
        );
        return {
          env: {
            SSH_ASKPASS: askpassCmdPath,
            SSH_ASKPASS_REQUIRE: "force",
            DISPLAY: process.env.DISPLAY || "netcatty:0",
            NETCATTY_ET_ASKPASS_MAP: askpassMapPath,
          },
          artifacts: [askpassMapPath, askpassScriptPath, askpassCmdPath],
        };
      }

      // Unix: ssh execs SSH_ASKPASS directly, so the helper must be runnable
      // without relying on a `node` on PATH. The `.cjs` shebang (#!/usr/bin/env
      // node) breaks in packaged builds because Electron does not put a `node`
      // binary on the user's PATH. Mirror the Windows .cmd wrapper: run the
      // script through Electron's own executable with ELECTRON_RUN_AS_NODE=1.
      const askpassWrapperPath = path.join(sshDir, "netcatty-et-askpass.sh");
      const electronExec = shellSingleQuote(process.execPath);
      writeSecureFile(
        askpassWrapperPath,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${electronExec} "$(dirname "$0")/netcatty-et-askpass.cjs" "$@"\n`,
        0o700,
      );
      return {
        env: {
          SSH_ASKPASS: askpassWrapperPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: process.env.DISPLAY || "netcatty:0",
          NETCATTY_ET_ASKPASS_MAP: askpassMapPath,
        },
        artifacts: [askpassMapPath, askpassScriptPath, askpassWrapperPath],
      };
    }

    function copyIfExists(sourcePath, targetPath) {
      try {
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath);
        }
      } catch {
        // ignore copy failures
      }
    }

    /**
     * Build a private SSH home + options for the `et` client's internal ssh.
     * Returns { userHost, sshOptions, identityFilePaths, env, artifacts }. comma-free option
     * values go in `sshOptions` (passed via --ssh-option); options that need
     * commas/spaces are written to a config file under HOME/.ssh/config.
     */
    function prepareEtSshEnvironment(sessionId, options) {
      const jumpHosts = Array.isArray(options.jumpHosts) ? options.jumpHosts : [];
      if (jumpHosts.length > 1) {
        throw new Error("EternalTerminal currently supports at most one jump host in Netcatty.");
      }

      const tempDir = tempDirBridge.getTempFilePath(`et-ssh-home-${sessionId}`);
      const sshDir = path.join(tempDir, ".ssh");
      fs.mkdirSync(sshDir, { recursive: true });

      const safeId = String(sessionId || "session").replace(/[^\w.-]/g, "_");
      // sshOptions: comma-free values safe for --ssh-option (ET may split on commas)
      const sshOptions = [];
      // configLines: options that need commas or spaces, written to config file
      const configLines = [];
      const askpassEntries = [];

      // Copy known_hosts from real ~/.ssh so already-trusted hosts verify
      // silently. Always point ssh at the persistent user file so
      // StrictHostKeyChecking=accept-new records a first-seen key for later
      // mismatch detection instead of trusting it again on every ET session.
      const realSshDir = path.join(os.homedir(), ".ssh");
      fs.mkdirSync(realSshDir, { recursive: true });
      let defaultIdentityPaths = [];
      try {
        const identityNames = fs.readdirSync(realSshDir, { withFileTypes: true })
          .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && SSH_KEY_PATTERN.test(entry.name))
          .map((entry) => entry.name);
        defaultIdentityPaths = orderSshIdentityNames(identityNames)
          .map((name) => path.join(realSshDir, name));
      } catch {
        // Local key discovery is optional. Password-only and interactive ET
        // sessions must still work when ~/.ssh cannot be read.
      }
      const knownHostsPath = path.join(realSshDir, "known_hosts");
      const verifyHostKeys = options.verifyHostKeys !== false;

      // et drives ssh itself and feeds credentials through SSH_ASKPASS, which
      // only answers password/passphrase prompts — never the interactive
      // host-key "yes/no" confirmation. Without this, a first-time host makes
      // et's internal ssh stall on that unanswerable prompt while its
      // handshake text leaks to the PTY, and the renderer flips the tab to
      // "connected" on that first byte (terminalSessionAttachment.ts) even
      // though no shell exists yet. accept-new trusts a brand-new host
      // automatically but still rejects a *changed* key (MITM protection);
      // LogLevel=ERROR silences the "Permanently added..." notice and other
      // ssh banners so the first real PTY bytes are the remote shell. Mirrors
      // the options already used by execOnEtSession.
      //
      // Vault known_hosts (issue #2501):
      //  - Destination hop: enforced via --ssh-option (ET applies these only
      //    to the final target; temp-HOME Host blocks are unreliable on POSIX).
      //  - Jump hop: enforced via Host <jump> config block (ProxyJump child
      //    process does not inherit --ssh-option).
      // Build per-hop snapshots so shared multi-host system lines are filtered
      // only for the hop that is vault-pinned.
      let targetAuthoritativeKnownHostsPath = null;
      let jumpAuthoritativeKnownHostsPath = null;
      let emptyKnownHostsPath = null;
      const targetConnectionHost = {
        hostname: options.hostname,
        port: options.port || 22,
      };
      const jumpConnectionHosts = jumpHosts.map((jump) => ({
        hostname: jump.hostname,
        port: jump.port || 22,
      }));
      const vaultPinsTarget = vaultPinsConnectionHosts(options.knownHosts, [targetConnectionHost]);
      const vaultPinsJump = vaultPinsConnectionHosts(options.knownHosts, jumpConnectionHosts);
      if (verifyHostKeys) {
        // Per-connection memo only — never process-lifetime, so ssh_config
        // edits are observed on the next connect (Codex P1).
        const sshGMemo = new Map();
        if (vaultPinsTarget) {
          const targetContent = buildAuthoritativeKnownHostsContent({
            knownHosts: options.knownHosts,
            fs,
            hostname: options.hostname,
            port: options.port || 22,
            username: options.username,
            pathModule: path,
            homedir: os.homedir(),
            memo: sshGMemo,
          });
          if (targetContent) {
            targetAuthoritativeKnownHostsPath = path.join(
              sshDir,
              `${safeId}-authoritative-target-known_hosts`,
            );
            writeSecureFile(targetAuthoritativeKnownHostsPath, targetContent, 0o600);
          }
        }
        if (vaultPinsJump && jumpHosts[0]) {
          const jumpContent = buildAuthoritativeKnownHostsContent({
            knownHosts: options.knownHosts,
            fs,
            hostname: jumpHosts[0].hostname,
            port: jumpHosts[0].port || 22,
            username: jumpHosts[0].username,
            pathModule: path,
            homedir: os.homedir(),
            memo: sshGMemo,
          });
          if (jumpContent) {
            jumpAuthoritativeKnownHostsPath = path.join(
              sshDir,
              `${safeId}-authoritative-jump-known_hosts`,
            );
            writeSecureFile(jumpAuthoritativeKnownHostsPath, jumpContent, 0o600);
          }
        }
      } else {
        // StrictHostKeyChecking=no still consults known_hosts for password-auth
        // MITM protection. Point both trust files at an empty snapshot so
        // verifyHostKeys=false truly bypasses stale vault/system pins.
        emptyKnownHostsPath = path.join(sshDir, `${safeId}-empty-known_hosts`);
        writeSecureFile(emptyKnownHostsPath, "", 0o600);
      }

      // Destination hop host-key policy via --ssh-option.
      if (verifyHostKeys && !targetAuthoritativeKnownHostsPath) {
        sshOptions.push(`UserKnownHostsFile=${normalizeSshConfigPath(knownHostsPath)}`);
      }
      sshOptions.push(...buildExternalHostKeySshOptions({
        authoritativeKnownHostsPath: targetAuthoritativeKnownHostsPath,
        emptyKnownHostsPath,
        verifyHostKeys,
        protocol: "et",
        style: "values",
        normalizePath: normalizeSshConfigPath,
      }));
      if (!sshOptions.some((opt) => opt.startsWith("StrictHostKeyChecking="))) {
        sshOptions.push("StrictHostKeyChecking=accept-new");
      }
      sshOptions.push("LogLevel=ERROR");

      // Port
      if (options.port && options.port !== 22) {
        sshOptions.push(`Port=${options.port}`);
      }

      if (options.useSshAgent === false) {
        configLines.push("IdentityAgent none");
      } else if (options.useSshAgent && options._resolvedSshAgentSocket) {
        configLines.push(`IdentityAgent ${quoteRawSshConfigValue(options._resolvedSshAgentSocket)}`);
      }
      // Private key
      const identityPaths = [];
      let tempKeyPath = null;
      if (options.privateKey) {
        tempKeyPath = path.join(sshDir, `${safeId}-key`);
        writeSecureFile(tempKeyPath, options.privateKey, 0o600);
        identityPaths.push(tempKeyPath);
        if (options.passphrase) {
          const passphrasePath = path.join(sshDir, `${safeId}-passphrase.txt`);
          writeSecureFile(passphrasePath, `${options.passphrase}\n`, 0o600);
          addAskpassEntry(askpassEntries, "passphrase", createPassphrasePromptMatchers(tempKeyPath), passphrasePath);
        }
      }

      if (options.useSshAgent && Array.isArray(options.agentPublicKeys)) {
        for (let index = 0; index < options.agentPublicKeys.length; index += 1) {
          const publicKey = options.agentPublicKeys[index];
          if (typeof publicKey !== "string" || !publicKey.trim()) continue;
          const selectorPath = path.join(sshDir, `${safeId}-agent-${index}.pub`);
          writeSecureFile(selectorPath, publicKey, 0o600);
          identityPaths.push(selectorPath);
        }
      }

      // Certificate
      if (options.certificate) {
        const certPath = path.join(sshDir, `${safeId}-cert.pub`);
        writeSecureFile(certPath, options.certificate, 0o600);
        sshOptions.push(`CertificateFile=${normalizeSshConfigPath(certPath)}`);
      }

      // Additional identity file paths from host config
      if (Array.isArray(options.identityFilePaths)) {
        for (const idPath of options.identityFilePaths) {
          if (idPath) {
            identityPaths.push(options.useSshAgent ? publicIdentitySelectorPath(idPath) : idPath);
          }
        }
      }

      if (options.authMethod === "auto") {
        for (const keyPath of defaultIdentityPaths) {
          if (!identityPaths.includes(keyPath)) {
            identityPaths.push(keyPath);
          }
        }
      }

      for (const idPath of identityPaths) {
        sshOptions.push(`IdentityFile=${normalizeSshConfigPath(idPath)}`);
      }

      const hasStrictTargetAuth = options.authMethod === "key" || options.authMethod === "certificate";
      if (hasStrictTargetAuth && identityPaths.length === 0) {
        sshOptions.push("IdentityFile=none");
      }

      if (
        (options.authMethod !== "auto" && !options.useSshAgent && (identityPaths.length > 0 || options.authMethod === "key" || options.authMethod === "certificate"))
        || (options.useSshAgent && options.identitiesOnly)
      ) {
        sshOptions.push("IdentitiesOnly=yes");
      }

      // Password
      const hasPassword = typeof options.password === "string" && options.password.length > 0;
      if (hasPassword) {
        const passwordPath = path.join(sshDir, `${safeId}-password.txt`);
        writeSecureFile(passwordPath, `${options.password}\n`, 0o600);
        addAskpassEntry(askpassEntries, "password", createPasswordPromptMatchers({
          hostname: options.hostname,
          username: options.username,
          port: options.port,
        }), passwordPath);
      }

      // Auth method preferences
      // NOTE: values with commas (e.g. "password,keyboard-interactive") MUST go into
      // the config file — ET on Windows passes --ssh-option values through cmd.exe
      // which treats commas as argument delimiters.
      const targetPreferredAuthentications = buildPreferredAuthentications({
        authMethod: options.authMethod,
        requiresMfa: !!options.requiresMfa,
        hasPassword,
        hasPublicKey: Boolean(options.useSshAgent || identityPaths.length > 0),
      });
      if (options.authMethod === "password") {
        sshOptions.push("PubkeyAuthentication=no");
      }
      if (targetPreferredAuthentications) {
        if (targetPreferredAuthentications.includes(",")) {
          configLines.push(`PreferredAuthentications ${targetPreferredAuthentications}`);
        } else {
          sshOptions.push(`PreferredAuthentications=${targetPreferredAuthentications}`);
        }
      }

      sshOptions.push("KbdInteractiveAuthentication=yes");
      sshOptions.push("NumberOfPasswordPrompts=1");

      // Legacy algorithms (all values contain commas → config file only)
      if (options.legacyAlgorithms) {
        configLines.push("KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1");
        configLines.push("Ciphers +aes128-cbc,aes256-cbc,3des-cbc");
        configLines.push("HostKeyAlgorithms +ssh-rsa,ssh-dss");
        configLines.push("PubkeyAcceptedAlgorithms +ssh-rsa,ssh-dss");
      }

      // Jump host — route through ET's own --jumphost/--jport so the ET TCP
      // socket connects to the jumphost's etserver and the destination is
      // reached over the SSH tunnel ET sets up with `ssh -J jumphost dest`.
      // (A bare ssh ProxyCommand only fixes the SSH bootstrap; ET would still
      // open its socket straight at the unreachable destination etserver.)
      //
      // ET passes the destination's --ssh-option values via `ssh -o`, which
      // OpenSSH applies to the final hop only. The jump hop is configured by
      // OpenSSH from ssh_config, so the jump's per-hop credentials/settings go
      // into a `Host <jumphost>` block in the config file. To keep the
      // destination's auth from leaking onto the jump hop, scope the
      // destination's comma/space config lines under a `Host <dest>` block too
      // whenever a jump host is present.
      let etJumpArgs = [];
      const jumpConfigLines = [];
      if (jumpHosts[0]) {
        const jump = jumpHosts[0];
        const jumpUser = jump.username || os.userInfo().username;
        const jumpHost = jump.hostname;
        const jumpPort = jump.port || 22;
        // ET server port on the jumphost. ET's own default is 2022; honor an
        // explicit override if the jump host model ever carries one.
        const jumpEtPort = jump.etPort || 2022;

        // Tell ET to tunnel through the jumphost. ET opens its ET socket to
        // <jumphost>:<jport> and adds `ssh -J <jumpUser@jumpHost>` for the
        // bootstrap; we feed the destination via the positional host as usual.
        etJumpArgs = ["--jumphost", `${jumpUser}@${jumpHost}`, "--jport", String(jumpEtPort)];

        // Per-hop jump settings live in a `Host <jumpHost>` block so they apply
        // to the ProxyJump connection only (not the destination).
        // Do NOT set HostName to the alias token here: OpenSSH keeps the first
        // obtained value, so a redundant `HostName bastion` would freeze the
        // literal name and prevent the later Include of ~/.ssh/config from
        // supplying the real HostName (e.g. 10.0.0.5). That would also diverge
        // from the vault snapshot built via `ssh -G` against the real config.
        // Omitting HostName lets Include resolve aliases; plain hostnames still
        // default HostName to the Host token (Codex P1 on PR #2529).
        jumpConfigLines.push(`Host ${jumpHost}`);
        jumpConfigLines.push(`  User ${jumpUser}`);
        jumpConfigLines.push(`  Port ${jumpPort}`);

        if (jump.useSshAgent === false) {
          jumpConfigLines.push("  IdentityAgent none");
        } else if (jump.useSshAgent && jump._resolvedSshAgentSocket) {
          jumpConfigLines.push(`  IdentityAgent ${quoteRawSshConfigValue(jump._resolvedSshAgentSocket)}`);
        }

        if (jump.useSshAgent && Array.isArray(jump.agentPublicKeys)) {
          for (let index = 0; index < jump.agentPublicKeys.length; index += 1) {
            const publicKey = jump.agentPublicKeys[index];
            if (typeof publicKey !== "string" || !publicKey.trim()) continue;
            const selectorPath = path.join(sshDir, `${safeId}-jump-agent-${index}.pub`);
            writeSecureFile(selectorPath, publicKey, 0o600);
            jumpConfigLines.push(`  IdentityFile ${quoteSshConfigValue(selectorPath)}`);
          }
        }

        // Jump host key
        if (jump.privateKey) {
          const jumpKeyPath = path.join(sshDir, `${safeId}-jump-key`);
          writeSecureFile(jumpKeyPath, jump.privateKey, 0o600);
          jumpConfigLines.push(`  IdentityFile ${quoteSshConfigValue(jumpKeyPath)}`);
          jumpConfigLines.push("  IdentitiesOnly yes");
          if (jump.passphrase) {
            const jumpPassPath = path.join(sshDir, `${safeId}-jump-passphrase.txt`);
            writeSecureFile(jumpPassPath, `${jump.passphrase}\n`, 0o600);
            addAskpassEntry(askpassEntries, "passphrase", createPassphrasePromptMatchers(jumpKeyPath), jumpPassPath);
          }
        } else if (Array.isArray(jump.identityFilePaths)) {
          const jumpIdentityPaths = jump.identityFilePaths
            .filter(Boolean)
            .map((identityPath) => jump.useSshAgent ? publicIdentitySelectorPath(identityPath) : identityPath);
          for (const idPath of jumpIdentityPaths) {
            jumpConfigLines.push(`  IdentityFile ${quoteSshConfigValue(idPath)}`);
          }
          if (jumpIdentityPaths.length > 0 && (!jump.useSshAgent || jump.identitiesOnly)) {
            jumpConfigLines.push("  IdentitiesOnly yes");
          }
        }

        if (jump.useSshAgent && jump.identitiesOnly && !jumpConfigLines.includes("  IdentitiesOnly yes")) {
          jumpConfigLines.push("  IdentitiesOnly yes");
        }

        const hasStrictJumpAuth = jump.authMethod === "key" || jump.authMethod === "certificate";
        const hasSelectedJumpIdentity = jumpConfigLines.some((line) => line.startsWith("  IdentityFile "));
        if (hasStrictJumpAuth && !hasSelectedJumpIdentity) {
          jumpConfigLines.push("  IdentityFile none");
          if (!jumpConfigLines.includes("  IdentitiesOnly yes")) {
            jumpConfigLines.push("  IdentitiesOnly yes");
          }
        }

        if (jump.authMethod === "auto") {
          for (const keyPath of defaultIdentityPaths) {
            jumpConfigLines.push(`  IdentityFile ${quoteSshConfigValue(keyPath)}`);
          }
        } else if (jump.authMethod === "password") {
          jumpConfigLines.push("  PubkeyAuthentication no");
        }

        const jumpPreferredAuthentications = buildPreferredAuthentications({
          authMethod: jump.authMethod,
          requiresMfa: !!jump.requiresMfa,
          hasPassword: typeof jump.password === "string" && jump.password.length > 0,
          hasPublicKey: Boolean(
            jump.useSshAgent ||
            jumpConfigLines.some((line) => line.startsWith("  IdentityFile ")),
          ),
        });
        if (jumpPreferredAuthentications) {
          jumpConfigLines.push(`  PreferredAuthentications ${jumpPreferredAuthentications}`);
        }

        // Jump host certificate
        if (jump.certificate) {
          const jumpCertPath = path.join(sshDir, `${safeId}-jump-cert.pub`);
          writeSecureFile(jumpCertPath, jump.certificate, 0o600);
          jumpConfigLines.push(`  CertificateFile ${quoteSshConfigValue(jumpCertPath)}`);
        }

        // Jump host password
        if (jump.password) {
          const jumpPwPath = path.join(sshDir, `${safeId}-jump-password.txt`);
          writeSecureFile(jumpPwPath, `${jump.password}\n`, 0o600);
          addAskpassEntry(askpassEntries, "password", createPasswordPromptMatchers({
            hostname: jumpHost,
            username: jumpUser,
            port: jumpPort,
          }), jumpPwPath);
        }

        // Jump-host host-key policy must live in this Host block: ET's
        // --ssh-option values apply only to the final destination hop, while
        // ProxyJump starts a separate OpenSSH process that reads the jump
        // stanza (see comment near etJumpArgs).
        if (verifyHostKeys) {
          if (jumpAuthoritativeKnownHostsPath) {
            jumpConfigLines.push(...buildExternalHostKeyConfigLines({
              authoritativeKnownHostsPath: jumpAuthoritativeKnownHostsPath,
              verifyHostKeys: true,
              protocol: "et",
              normalizePath: normalizeSshConfigPath,
              quotePath: quoteSshConfigValue,
            }));
          } else {
            jumpConfigLines.push(`  UserKnownHostsFile ${quoteSshConfigValue(knownHostsPath)}`);
            jumpConfigLines.push("  StrictHostKeyChecking accept-new");
          }
        } else if (emptyKnownHostsPath) {
          jumpConfigLines.push(...buildExternalHostKeyConfigLines({
            emptyKnownHostsPath,
            verifyHostKeys: false,
            protocol: "et",
            normalizePath: normalizeSshConfigPath,
            quotePath: quoteSshConfigValue,
          }));
        }
        jumpConfigLines.push("  LogLevel ERROR");
        jumpConfigLines.push("  KbdInteractiveAuthentication yes");
        jumpConfigLines.push("  NumberOfPasswordPrompts 1");

        if (options.legacyAlgorithms) {
          jumpConfigLines.push("  KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1");
          jumpConfigLines.push("  Ciphers +aes128-cbc,aes256-cbc,3des-cbc");
          jumpConfigLines.push("  HostKeyAlgorithms +ssh-rsa,ssh-dss");
          jumpConfigLines.push("  PubkeyAcceptedAlgorithms +ssh-rsa,ssh-dss");
        }
      }

      // Write config file. When a jump host is present, scope the destination's
      // comma/space options under `Host <dest>` so they don't bleed onto the
      // jump hop, add `ProxyJump <jumpHost>` there so the standalone `ssh`
      // used by execOnEtSession also tunnels through the jump (ET's own
      // command-line -J overrides this for the interactive session, resolving
      // to the same single hop), then append the `Host <jumpHost>` block.
      const configFileLines = [];
      if (jumpConfigLines.length > 0) {
        const jump = jumpHosts[0];
        configFileLines.push(`Host ${options.hostname}`);
        configFileLines.push(`  ProxyJump ${jump.hostname}`);
        for (const line of configLines) {
          configFileLines.push(`  ${line}`);
        }
        configFileLines.push(...jumpConfigLines);
      } else {
        configFileLines.push(...configLines);
      }

      const writesConfigFile = configFileLines.length > 0;
      let configPath = null;
      if (writesConfigFile) {
        // -F replaces the per-user config and also skips the system-wide
        // config. Append Include directives AFTER our Host blocks so:
        //   1) first-obtained-value keeps session overrides (ProxyJump,
        //      vault known_hosts, IdentityFile, …) for matched hosts, and
        //   2) HostName aliases / ProxyCommand / algorithms from the user's
        //      normal ~/.ssh/config still apply (Codex P1 on PR #2529).
        const includeLines = [];
        try {
          const realUserConfig = path.join(os.homedir(), ".ssh", "config");
          if (fs.existsSync(realUserConfig)) {
            includeLines.push(`Include ${quoteSshConfigValue(realUserConfig)}`);
          }
        } catch {
          // ignore
        }
        try {
          const systemConfigs = process.platform === "win32"
            ? [path.join(process.env.ProgramData || "C:\\ProgramData", "ssh", "ssh_config")]
            : ["/etc/ssh/ssh_config"];
          for (const systemConfig of systemConfigs) {
            if (fs.existsSync(systemConfig)) {
              includeLines.push(`Include ${quoteSshConfigValue(systemConfig)}`);
            }
          }
        } catch {
          // ignore
        }
        if (includeLines.length > 0) {
          // Reset Host/Match context first. Without this, Includes after a
          // `Host <jump>` stanza stay conditional on the jump host and are
          // skipped for the destination (Codex P1).
          configFileLines.push("");
          configFileLines.push("Match all");
          configFileLines.push("# Preserve normal OpenSSH user/system configuration under -F.");
          configFileLines.push(...includeLines);
        }
        configPath = path.join(sshDir, "config");
        writeSecureFile(configPath, configFileLines.join("\n") + "\n", 0o600);
      }

      // Create askpass artifacts
      const askpass = createEtAskpassArtifacts(sshDir, askpassEntries);

      // OpenSSH resolves the user config from the account home directory, not
      // $HOME. When we generate a private config (ProxyJump + jump host-key
      // policy), inject a PATH-fronted `ssh` wrapper that always passes
      // `-F <session-config>` so both interactive ET (ssh -J) and follow-up
      // execOnEtSession honor the generated Host stanzas.
      const pathEnv = {};
      if (configPath) {
        try {
          // Resolve the real OpenSSH binary to an absolute path BEFORE we
          // prepend the wrapper directory to PATH. Embedding a bare `ssh`
          // name would recurse into the wrapper forever.
          let realSsh = process.platform === "win32"
            ? (findExecutable("ssh") || "")
            : "";
          if (!realSsh || !path.isAbsolute(realSsh)) {
            try {
              const resolved = execFileSync(
                process.platform === "win32" ? "where" : "sh",
                process.platform === "win32" ? ["ssh"] : ["-c", "command -v ssh"],
                {
                  encoding: "utf8",
                  timeout: 2000,
                  windowsHide: true,
                  env: process.env,
                },
              ).trim().split(/\r?\n/)[0];
              if (resolved) realSsh = resolved;
            } catch {
              // Fall through to common absolute locations.
            }
          }
          if (!realSsh || !path.isAbsolute(String(realSsh))) {
            const candidates = process.platform === "win32"
              ? []
              : ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"];
            realSsh = candidates.find((candidate) => {
              try { return fs.existsSync(candidate); } catch { return false; }
            }) || realSsh || "ssh";
          }
          if (!path.isAbsolute(String(realSsh))) {
            throw new Error("unable to resolve absolute OpenSSH path for wrapper");
          }
          const wrapperDir = path.join(sshDir, "bin");
          fs.mkdirSync(wrapperDir, { recursive: true });
          if (process.platform === "win32") {
            const wrapperPath = path.join(wrapperDir, "ssh.cmd");
            writeSecureFile(
              wrapperPath,
              `@echo off\r\n"${String(realSsh).replace(/"/g, '""')}" -F "${configPath.replace(/"/g, '""')}" %*\r\n`,
              0o700,
            );
          } else {
            const wrapperPath = path.join(wrapperDir, "ssh");
            const quotedSsh = `'${String(realSsh).replace(/'/g, `'\\''`)}'`;
            const quotedConfig = `'${String(configPath).replace(/'/g, `'\\''`)}'`;
            writeSecureFile(
              wrapperPath,
              `#!/bin/sh\nexec ${quotedSsh} -F ${quotedConfig} "$@"\n`,
              0o700,
            );
          }
          // Prepend the wrapper to the effective session PATH (options.env),
          // not bare process.env — host/session PATH may carry ProxyCommand
          // helpers that must remain visible (Codex P2).
          const sessionEnv = options.env && typeof options.env === "object" ? options.env : {};
          const pathKey = Object.keys(sessionEnv).find((k) => k.toLowerCase() === "path")
            || Object.keys(process.env).find((k) => k.toLowerCase() === "path")
            || "PATH";
          const currentPath = sessionEnv[pathKey]
            || sessionEnv.PATH
            || sessionEnv.Path
            || process.env[pathKey]
            || process.env.PATH
            || "";
          pathEnv[pathKey] = currentPath ? `${wrapperDir}${path.delimiter}${currentPath}` : wrapperDir;
        } catch {
          // Wrapper is best-effort; destination --ssh-option still applies.
        }
      }

      const userHost = `${options.username || os.userInfo().username}@${options.hostname}`;

      return {
        userHost,
        sshOptions,
        identityFilePaths: identityPaths,
        etJumpArgs,
        env: {
          // Set HOME/USERPROFILE so helpers that honor $HOME still find the
          // session config; the PATH wrapper above is the enforceable path.
          ...(writesConfigFile ? { HOME: tempDir, USERPROFILE: tempDir } : {}),
          ...pathEnv,
          ...askpass.env,
        },
        artifacts: [tempDir, ...askpass.artifacts],
      };
    }

    /**
     * Remove leftover et-ssh-home-* temp directories from previous sessions
     * that were not cleaned up (e.g. due to a crash).
     */
    function cleanupStaleEtTempDirs() {
      try {
        const tempDir = tempDirBridge.getTempDir();
        if (!fs.existsSync(tempDir)) return;
        const entries = fs.readdirSync(tempDir);
        for (const entry of entries) {
          if (!entry.startsWith("et-ssh-home-")) continue;
          try {
            fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true });
          } catch {
            // ignore per-entry cleanup failures
          }
        }
      } catch {
        // ignore — best-effort cleanup
      }
    }

    function cleanupSessionExternalAuthArtifacts(session) {
      if (!session || session.externalAuthArtifactsCleaned) return;
      session.externalAuthArtifactsCleaned = true;
      const artifacts = Array.isArray(session.externalAuthArtifacts)
        ? session.externalAuthArtifacts
        : [];

      for (const artifactPath of artifacts) {
        try {
          fs.rmSync(artifactPath, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }

    /**
     * Prepend an optional bundled DLL directory (dynamically-linked Windows
     * builds only) to PATH so the spawned et.exe can find its runtime DLLs.
     * Static MSVC builds ship no DLLs and this is a no-op.
     */
    function addBundledEtDllPath(env, etClient, opts = {}) {
      const platform = opts.platform || process.platform;
      if (platform !== "win32" || !etClient) return env;
      const clientDir = path.dirname(etClient);
      const arch = opts.arch || process.arch;
      const dllDir = path.join(clientDir, `et-win32-${arch}-dlls`);
      if (fs.existsSync(dllDir) && fs.statSync(dllDir).isDirectory()) {
        const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
        const current = env[pathKey] || "";
        env[pathKey] = current ? `${dllDir};${current}` : dllDir;
      }
      return env;
    }

    /**
     * Build a known_hosts file for background ET exec (stats / distro probes).
     * Reuses the vault-authoritative snapshot builder so system pins for
     * vault-covered hosts cannot override the vault key (same policy as the
     * interactive ET bootstrap). Falls back to system+vault merge without
     * filtering when the vault has no usable pins.
     */
    function ensureStrictExecKnownHostsFile(session, knownHosts) {
      if (session.etStrictExecKnownHostsPath) {
        return session.etStrictExecKnownHostsPath;
      }

      const hostname = session.etStatsAuth?.hostname
        || session.sshUserHost?.split("@").pop()
        || "localhost";
      let content = buildAuthoritativeKnownHostsContent({
        knownHosts,
        fs,
        hostname,
        port: session.etStatsAuth?.port || 22,
        username: session.etStatsAuth?.username,
        pathModule: path,
        homedir: os.homedir(),
      });

      // No vault pins: keep the previous fail-closed merge of system + any
      // configured user known_hosts so probes still have a trust source.
      if (!content) {
        const { readSystemKnownHostsContent } = createSystemKnownHostsApi({
          fs, path, os, crypto, log: console,
        });
        const chunks = [];
        try {
          const systemContent = readSystemKnownHostsContent();
          if (systemContent) chunks.push(systemContent);
        } catch {
          // ignore read failures — strict checking fails closed below
        }
        const configuredKnownHosts = (session.sshOptions || []).find(
          (opt) => opt.startsWith("UserKnownHostsFile="),
        );
        if (configuredKnownHosts) {
          const configuredPath = configuredKnownHosts.slice("UserKnownHostsFile=".length)
            .replace(/^"|"$/g, "");
          try {
            const configuredContent = fs.readFileSync(configuredPath, "utf8");
            if (configuredContent) chunks.push(configuredContent);
          } catch {
            // ignore missing configured file
          }
        }
        content = chunks.filter(Boolean).join("\n");
        if (content && !content.endsWith("\n")) content += "\n";
      }

      const artifact = Array.isArray(session.externalAuthArtifacts)
        ? session.externalAuthArtifacts[0]
        : null;
      const sshDir = artifact ? path.dirname(artifact) : tempDirBridge.getTempDir();
      const strictKhPath = path.join(sshDir, "netcatty-et-strict-known_hosts");
      writeSecureFile(strictKhPath, content || "", 0o600);
      session.etStrictExecKnownHostsPath = strictKhPath;
      if (Array.isArray(session.externalAuthArtifacts)) {
        session.externalAuthArtifacts.push(strictKhPath);
      }
      return strictKhPath;
    }

    /**
     * Execute a remote command on an ET session by spawning a system ssh
     * process. Reuses the SSH environment (keys, config, askpass) already
     * prepared by prepareEtSshEnvironment() for the ET connection.
     *
     * @param {object} [execOpts]
     * @param {boolean} [execOpts.requireTrustedHost] When true, refuse unknown
     *   host keys (StrictHostKeyChecking=yes) using system + vault known_hosts
     *   instead of accept-new. Used for background stats/distro probes.
     * @param {Array} [execOpts.knownHosts] Netcatty vault known hosts to merge
     *   into the strict known_hosts file (defaults to session.etStatsAuth).
     */
    function execOnEtSession(session, command, timeoutMs = 5000, execOpts = {}) {
      if (!session?.sshUserHost || session.externalAuthArtifactsCleaned) {
        return Promise.resolve({ success: false, error: "ET SSH environment not available" });
      }

      const requireTrustedHost = execOpts.requireTrustedHost === true;
      const knownHosts = execOpts.knownHosts ?? session.etStatsAuth?.knownHosts;

      const sshCmd = process.platform === "win32" ? findExecutable("ssh") : "ssh";
      const args = ["-o", "BatchMode=no"];
      // OpenSSH resolves the user config from the account home directory, not
      // $HOME. Force the session-generated config (ProxyJump + jump Host-key
      // policy) with -F so the ProxyJump child actually sees it.
      const sessionHome = session.sshEnv?.HOME || session.sshEnv?.USERPROFILE;
      if (sessionHome) {
        const sessionConfigPath = path.join(sessionHome, ".ssh", "config");
        try {
          if (fs.existsSync(sessionConfigPath)) {
            args.push("-F", sessionConfigPath);
          }
        } catch {
          // Best-effort; fall through without -F.
        }
      }
      // OpenSSH keeps the first StrictHostKeyChecking value it sees. Only inject
      // accept-new when the session did not already supply a policy (e.g.
      // verifyHostKeys=false → StrictHostKeyChecking=no on the interactive ET
      // bootstrap). Prepending accept-new would otherwise win over the session
      // setting and re-enable mismatch rejection on follow-up ssh execs.
      const sessionHasStrictHostKeyChecking = (session.sshOptions || []).some(
        (opt) => typeof opt === "string" && opt.startsWith("StrictHostKeyChecking="),
      );
      if (!requireTrustedHost && !sessionHasStrictHostKeyChecking) {
        args.push("-o", "StrictHostKeyChecking=accept-new");
      }
      for (const opt of session.sshOptions) {
        if (requireTrustedHost && opt.startsWith("StrictHostKeyChecking=")) continue;
        if (requireTrustedHost && opt.startsWith("UserKnownHostsFile=")) continue;
        args.push("-o", opt);
      }
      if (requireTrustedHost) {
        const strictKhPath = ensureStrictExecKnownHostsFile(session, knownHosts);
        args.push("-o", `UserKnownHostsFile=${normalizeSshConfigPath(strictKhPath)}`);
        args.push("-o", "StrictHostKeyChecking=yes");
      }
      args.push(session.sshUserHost, command);

      return new Promise((resolve) => {
        const { buildTerminalProcessEnv } = require("../httpNetworkProxyBridge.cjs");
        const execFileOptions = {
          env: { ...buildTerminalProcessEnv(process.env), ...session.sshEnv },
          timeout: timeoutMs,
          encoding: "utf8",
          windowsHide: true,
        };
        const maxBuffer = Number(execOpts.maxBuffer);
        if (Number.isFinite(maxBuffer) && maxBuffer > 0) {
          execFileOptions.maxBuffer = Math.floor(maxBuffer);
        }
        const child = execFile(sshCmd, args, execFileOptions, (err, stdout, stderr) => {
          if (err) {
            resolve({
              success: false,
              error: err.message,
              stdout: stdout || "",
              stderr: stderr || "",
              code: typeof err.code === "number" && err.code !== 0 ? err.code : 1,
            });
          } else {
            resolve({ success: true, stdout: stdout || "", stderr: stderr || "", code: 0 });
          }
        });
        if (typeof execOpts.stdin === "string") {
          child.stdin?.end(execOpts.stdin);
        }
      });
    }

    /**
     * Start an EternalTerminal session using Netcatty's bundled `et` client.
     */
    async function startEtSession(event, options) {
      const sessionId =
        options.sessionId ||
        `et-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const cols = options.cols || 80;
      const rows = options.rows || 24;

      const etCmd = resolveBareEtClient({});
      if (!etCmd) {
        throw new Error(
          "Bundled et client not found. Run `npm run fetch:et:dev` for local dev, " +
          "or ensure release packaging downloads the et binary release before building.",
        );
      }

      const args = [];

      // ET server port (default 2022)
      if (options.etPort && options.etPort !== 2022) {
        args.push("-p", String(options.etPort));
      }

      let sshEnvironment;
      let releaseFidoAgents = () => {};
      try {
        const preparedOptions = await prepareEtSshAgentOptions(options, event?.sender);
        releaseFidoAgents = createOneShotEtFidoAgentReleases(preparedOptions);
        options = preparedOptions;
        if (options.agentForwarding && options._resolvedForwardingAgentSocket) {
          args.push("-f", "--ssh-socket", options._resolvedForwardingAgentSocket);
        }
        sshEnvironment = prepareEtSshEnvironment(sessionId, preparedOptions);
      } catch (err) {
        releaseFidoAgents();
        throw new Error(err instanceof Error ? err.message : String(err));
      }

      // Pass all SSH options inline via --ssh-option (bypasses config file lookup)
      for (const opt of sshEnvironment.sshOptions) {
        args.push("--ssh-option", opt);
      }

      // Route through a jump host via ET's own --jumphost/--jport when set, so
      // ET's TCP socket targets the jumphost and the destination is reached
      // over the SSH tunnel rather than a direct (often unreachable) etserver.
      if (Array.isArray(sshEnvironment.etJumpArgs) && sshEnvironment.etJumpArgs.length > 0) {
        args.push(...sshEnvironment.etJumpArgs);
      }

      args.push(sshEnvironment.userHost);

      const { buildTerminalProcessEnv } = require("../httpNetworkProxyBridge.cjs");
      const env = {
        ...buildTerminalProcessEnv(process.env),
        ...(options.env || {}),
        ...(sshEnvironment?.env || {}),
        TERM: "xterm-256color",
        // et prints a 3-line telemetry notice to stdout on first run. The
        // "first run" flag is tracked per-HOME, and prepareEtSshEnvironment
        // gives each session a fresh private temp HOME, so et treats every
        // connection as first-run and prints it every time. That banner is
        // pre-connection output that both pollutes the terminal and trips the
        // renderer's "first PTY byte = connected" check
        // (terminalSessionAttachment.ts). Opt out unconditionally — this also
        // suppresses the notice and disables anonymous error reporting.
        ET_NO_TELEMETRY: "1",
      };

      applyEtSshAgentEnvironment(env, options);

      addBundledEtDllPath(env, etCmd);

      try {
        const proc = pty.spawn(etCmd, args, {
          cols,
          rows,
          env,
          cwd: os.homedir(),
          encoding: null, // Return Buffer for ZMODEM binary support
          useConptyDll: process.platform === "win32",
        });

        const session = {
          proc,
          pty: proc,
          type: "et",
          protocol: "et",
          webContentsId: event.sender.id,
          hostname: options.hostname || "",
          username: options.username || "",
          label: options.label || options.hostname || "ET Session",
          // Leave unset so ensureSessionShellKind can probe via companion SSH
          // exec before AI wrappers (fish login shells — issue #1854).
          shellKind: undefined,
          _shellKindExecProbe: async (command, timeoutMs) => {
            const result = await execOnEtSession(session, command, timeoutMs, {
              requireTrustedHost: true,
              knownHosts: session.etStatsAuth?.knownHosts,
            });
            return result?.success ? (result.stdout || "") : null;
          },
          shellExecutable: "remote-shell",
          externalAuthArtifacts: sshEnvironment?.artifacts || [],
          externalAuthArtifactsCleaned: false,
          // SSH environment for remote command execution (stats, distro detection)
          sshEnv: sshEnvironment?.env || {},
          sshOptions: sshEnvironment?.sshOptions || [],
          sshUserHost: sshEnvironment?.userHost || "",
          tcpLatencyTarget: {
            hostname: options.hostname,
            port: options.etPort || 2022,
          },
          tcpLatencyDirect:
            (!Array.isArray(options.jumpHosts) || options.jumpHosts.length === 0) && !options.proxy,
          etStatsAuth: {
            hostname: options.hostname,
            port: options.port || 22,
            username: options.username,
            authMethod: options.authMethod,
            password: options.password,
            privateKey: options.privateKey,
            passphrase: options.passphrase,
            certificate: options.certificate,
            keyId: options.keyId,
            identityFilePaths: sshEnvironment?.identityFilePaths,
            agentPublicKeys: options.agentPublicKeys,
            useSshAgent: options.useSshAgent,
            identityAgent: options.identityAgent,
            identitiesOnly: options.identitiesOnly,
            addKeysToAgent: options.addKeysToAgent,
            useKeychain: options.useKeychain,
            legacyAlgorithms: options.legacyAlgorithms,
            skipEcdsaHostKey: options.skipEcdsaHostKey,
            algorithmOverrides: options.algorithmOverrides,
            knownHosts: options.knownHosts,
            verifyHostKeys: options.verifyHostKeys,
            hasJumpHost: Array.isArray(options.jumpHosts) && options.jumpHosts.length > 0,
            hasProxy: !!options.proxy,
          },
          systemManagerSudoPassword: typeof options.sudoAutofillPassword === "string" && options.sudoAutofillPassword.length > 0
            ? options.sudoAutofillPassword
            : undefined,
          flushPendingData: null,
          lastIdlePrompt: "",
          lastIdlePromptAt: 0,
          _promptTrackTail: "",
          // Explicit close deletes the session before onExit; keep the one-shot
          // release on the session so closeSession / quit cleanup can still run it.
          releaseNetcattyFidoAgents: releaseFidoAgents,
        };
        {
          const { claimSessionSlot } = require("../sessionBootEpoch.cjs");
          const claim = claimSessionSlot(sessions, sessionId, session, options.bootEpoch);
          if (!claim.ok) {
            try { proc.kill(); } catch { /* ignore */ }
            cleanupSessionExternalAuthArtifacts(session);
            releaseFidoAgents();
            const supersededError = new Error("Connection superseded by a newer reconnect");
            supersededError.code = "NETCATTY_BOOT_SUPERSEDED";
            throw supersededError;
          }
        }
        openTerminalOutputSession?.(sessionId, event.sender);

        // Start real-time session log stream if configured
        if (options.sessionLog?.enabled && options.sessionLog?.directory) {
          const logStreamToken = sessionLogStreamManager.startStream(sessionId, {
            hostLabel: options.label || options.hostname,
            hostname: options.hostname,
            directory: options.sessionLog.directory,
            format: options.sessionLog.format || "txt",
            timestampsEnabled: Boolean(options.sessionLog.timestampsEnabled),
            startTime: Date.now(),
          });
          session.logStreamToken = logStreamToken;
        }

        const {
          bufferData: bufferEtData,
          flushPaced: flushEtPaced,
          discard: discardEt,
        } = createPtyOutputBuffer((data, meta) => {
          const contents = electronModule.webContents.fromId(session.webContentsId);
          emitTerminalSessionData(contents, sessionId, data, {
            session,
            cols: session.cols,
            rows: session.rows,
            meta,
          });
        }, {
          onPendingBytesChange: (bytes) => setBufferedOutputBytes(session, bytes),
          shouldAcceptOutput: () => sessions.get(sessionId) === session && shouldAcceptSessionOutput(session),
        });
        session.flushPendingData = flushEtPaced;
        session.discardPendingData = discardEt;

        if (process.platform !== "win32") {
          const etDecoder = new StringDecoder("utf8");
          const etZmodemSentry = createZmodemSentry({
            sessionId,
            onData(buf) {
              const str = etDecoder.write(buf);
              if (!str) return;
              trackSessionIdlePrompt(session, str);
              bufferEtData(str);
              sessionLogStreamManager.appendData(sessionId, str);
            },
            writeToRemote(buf) {
              try { return proc.write(buf); } catch { return true; }
            },
            getWebContents() {
              return electronModule.webContents.fromId(session.webContentsId);
            },
            selectUploadFiles: selectZmodemUploadFiles
              ? () => selectZmodemUploadFiles(session.webContentsId, sessionId)
              : undefined,
            selectDownloadDirectory: selectZmodemDownloadDirectory
              ? () => selectZmodemDownloadDirectory(session.webContentsId, sessionId)
              : undefined,
            label: "ET",
          });
          session.zmodemSentry = etZmodemSentry;

          proc.onData((data) => {
            if (sessions.get(sessionId) !== session) return;
            if (!shouldProcessSessionOutput(session, etZmodemSentry)) return;
            etZmodemSentry.consume(data);
          });
        } else {
          proc.onData((data) => {
            if (sessions.get(sessionId) !== session) return;
            if (!shouldProcessSessionOutput(session)) return;
            trackSessionIdlePrompt(session, data);
            bufferEtData(data);
            sessionLogStreamManager.appendData(sessionId, data);
          });
        }

        let etExitFinalized = false;
        proc.onExit((evt) => {
          flushEtPaced(() => {
            if (etExitFinalized) return;
            etExitFinalized = true;
            // Release before the map check: explicit close already deleted the
            // session entry, but the agent/askpass lease must still be dropped.
            releaseFidoAgents();
            if (sessions.get(sessionId) !== session) return;
            try { session.etStatsConn?.end(); } catch { /* ignore */ }
            cleanupSessionExternalAuthArtifacts(session);
            sessionLogStreamManager.stopStream(sessionId, session.logStreamToken);
            closeTerminalOutputSession?.(sessionId);
            sessions.delete(sessionId);
            if (session.closed) return;
            const contents = electronModule.webContents.fromId(session.webContentsId);
            fanoutSessionExit(sessionId, contents, {
              sessionId,
              ...evt,
              reason: evt.exitCode === 0 ? "exited" : "error",
              _terminalSessionGeneration: session._terminalSessionGeneration,
            });
          });
        });

        return { sessionId };
      } catch (err) {
        releaseFidoAgents();
        if (sshEnvironment?.artifacts) {
          cleanupSessionExternalAuthArtifacts({
            externalAuthArtifacts: sshEnvironment.artifacts,
            externalAuthArtifactsCleaned: false,
          });
        }
        console.error("[ET] Failed to start EternalTerminal session:", err.message);
        throw err;
      }
    }

    return {
      resolveBareEtClient,
      prepareEtSshEnvironment,
      prepareEtSshAgentOptions,
      applyEtSshAgentEnvironment,
      cleanupStaleEtTempDirs,
      cleanupSessionExternalAuthArtifacts,
      addBundledEtDllPath,
      execOnEtSession,
      startEtSession,
    };
  }
}

module.exports = { createEtSessionApi };
