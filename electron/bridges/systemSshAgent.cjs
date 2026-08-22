"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { utils } = require("ssh2");
const { BaseAgent, createAgent } = require("ssh2/lib/agent.js");

const execFileAsync = promisify(execFile);

function publicKeyBlob(key) {
  try {
    const parsed = typeof key?.getPublicSSH === "function" ? key : utils.parseKey(key);
    if (parsed instanceof Error || typeof parsed?.getPublicSSH !== "function") return null;
    return parsed.getPublicSSH().toString("base64");
  } catch {
    return null;
  }
}

/**
 * Shared (e.g. Windows system-pipe) agent identity holds. Concurrent sessions
 * that materialize the same SK key get unique temp paths, so cleanup must be
 * keyed by public identity blob and only `ssh-add -d` when the last user leaves.
 * @type {Map<string, { refCount: number, identityPath: string, cleanupDir: string|null }>}
 */
const sharedAgentIdentityRefs = new Map();

/**
 * @param {string} key Public identity blob (or path fallback)
 * @param {string} identityPath Path suitable for `ssh-add -d`
 * @param {string|null} [cleanupDir] Temp dir to remove with the last release
 * @returns {{ entry: { refCount: number, identityPath: string, cleanupDir: string|null }, acceptedCleanup: boolean }|null}
 *   `acceptedCleanup` is true only when this call recorded `cleanupDir` on a new
 *   map entry. Reuses increment refcount but do not adopt a second staging dir.
 */
function retainSharedAgentIdentity(key, identityPath, cleanupDir = null) {
  if (typeof key !== "string" || !key || typeof identityPath !== "string" || !identityPath) {
    return null;
  }
  const existing = sharedAgentIdentityRefs.get(key);
  if (existing) {
    existing.refCount += 1;
    // First retainer owns identityPath + cleanupDir for ssh-add -d / rm.
    return { entry: existing, acceptedCleanup: false };
  }
  const normalizedCleanup = typeof cleanupDir === "string" && cleanupDir ? cleanupDir : null;
  const entry = {
    refCount: 1,
    identityPath,
    cleanupDir: normalizedCleanup,
  };
  sharedAgentIdentityRefs.set(key, entry);
  return { entry, acceptedCleanup: Boolean(normalizedCleanup) };
}

/**
 * @param {string} key
 * @returns {{ shouldRemove: boolean, identityPath: string|null, cleanupDir: string|null }}
 */
function releaseSharedAgentIdentity(key) {
  if (typeof key !== "string" || !key) {
    return { shouldRemove: false, identityPath: null, cleanupDir: null };
  }
  const existing = sharedAgentIdentityRefs.get(key);
  if (!existing) return { shouldRemove: false, identityPath: null, cleanupDir: null };
  existing.refCount -= 1;
  if (existing.refCount > 0) {
    return {
      shouldRemove: false,
      identityPath: existing.identityPath,
      cleanupDir: existing.cleanupDir,
    };
  }
  sharedAgentIdentityRefs.delete(key);
  return {
    shouldRemove: true,
    identityPath: existing.identityPath,
    cleanupDir: existing.cleanupDir,
  };
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function hasSharedAgentIdentity(key) {
  return typeof key === "string" && key.length > 0 && sharedAgentIdentityRefs.has(key);
}

function resetSharedAgentIdentityRefsForTests() {
  sharedAgentIdentityRefs.clear();
}

function resolveIdentityPath(rawPath, context = {}) {
  if (typeof rawPath !== "string") return "";
  const env = context.env ?? process.env;
  const localHostname = context.localHostname || os.hostname();
  const hostname = context.hostname || "";
  const port = String(context.port || 22);
  const username = context.username || "";
  const proxyJump = context.proxyJump || "";
  const tokenValues = {
    "%": "%",
    d: os.homedir(),
    h: hostname,
    i: String(context.uid ?? (typeof process.getuid === "function" ? process.getuid() : "")),
    j: proxyJump,
    k: context.hostKeyAlias || hostname,
    L: context.shortLocalHostname || localHostname.split(".")[0],
    l: localHostname,
    n: context.originalHostname || hostname,
    p: port,
    r: username,
    u: context.localUsername || os.userInfo().username,
  };
  tokenValues.C = createHash("sha1")
    .update(`${localHostname}${hostname}${port}${username}${proxyJump}`)
    .digest("hex");
  let resolved = rawPath.trim()
    .replace(/%([%CdhijkLlnpru])/g, (match, token) => tokenValues[token] ?? match)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => env[name] ?? "");
  if (!path.isAbsolute(resolved) && resolved) {
    resolved = path.resolve(resolved);
  }
  return resolved;
}

async function loadPreferredPublicKeyBlobs(identityFilePaths, publicKeys, options, deps) {
  const preferred = new Set();
  const resolvedIdentityPaths = [];
  const unavailablePublicKeyPaths = [];
  let providedPreferredCount = 0;
  for (const publicKey of publicKeys ?? []) {
    const blob = publicKeyBlob(publicKey);
    if (blob) {
      preferred.add(blob);
      providedPreferredCount += 1;
    }
  }
  for (const rawPath of identityFilePaths ?? []) {
    const identityPath = resolveIdentityPath(rawPath, options);
    if (!identityPath) continue;
    resolvedIdentityPaths.push(identityPath);
    const publicKeyPath = identityPath.endsWith(".pub") ? identityPath : `${identityPath}.pub`;
    try {
      const contents = await deps.readFile(publicKeyPath, "utf8");
      const blob = publicKeyBlob(contents);
      if (blob) preferred.add(blob);
      else unavailablePublicKeyPaths.push(publicKeyPath);
    } catch (error) {
      unavailablePublicKeyPaths.push(publicKeyPath);
      deps.log?.("Configured SSH public key is unavailable", {
        publicKeyPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { preferred, providedPreferredCount, resolvedIdentityPaths, unavailablePublicKeyPaths };
}

function getIdentities(agent) {
  return new Promise((resolve, reject) => {
    agent.getIdentities((error, identities) => {
      if (error) reject(error);
      else resolve(Array.isArray(identities) ? identities : []);
    });
  });
}

class IdentityAwareAgent extends BaseAgent {
  constructor(delegate, preferred, identitiesOnly) {
    super();
    this.delegate = delegate;
    this.preferred = preferred;
    this.identitiesOnly = identitiesOnly;
  }

  getIdentities(callback) {
    this.delegate.getIdentities((error, identities) => {
      if (error) return callback(error);
      const keys = Array.isArray(identities) ? identities : [];
      const matching = [];
      const remaining = [];
      for (const key of keys) {
        if (this.preferred.has(publicKeyBlob(key))) matching.push(key);
        else remaining.push(key);
      }
      callback(null, this.identitiesOnly ? matching : [...matching, ...remaining]);
    });
  }

  sign(publicKey, data, options, callback) {
    this.delegate.sign(publicKey, data, options, callback);
  }

  getStream(callback) {
    if (typeof this.delegate.getStream !== "function") {
      callback(new Error("SSH agent does not support forwarding streams"));
      return;
    }
    this.delegate.getStream(callback);
  }
}

function shouldLoadFromMacKeychain(options, platform) {
  return platform === "darwin"
    && options.useKeychain === true
    && typeof options.addKeysToAgent === "string"
    && options.addKeysToAgent.toLowerCase() === "yes"
    && Array.isArray(options.identityFilePaths)
    && options.identityFilePaths.length > 0;
}

function resolveSshAddBinary(platform, env = process.env) {
  if (typeof env.NETCATTY_SSH_ADD_PATH === "string" && env.NETCATTY_SSH_ADD_PATH.trim()) {
    return env.NETCATTY_SSH_ADD_PATH.trim();
  }
  // Pair with Homebrew OpenSSH when present (same stack as ssh-agent / ssh-keygen).
  if (platform === "darwin") {
    for (const candidate of [
      "/opt/homebrew/bin/ssh-add",
      "/usr/local/bin/ssh-add",
      "/usr/bin/ssh-add",
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  if (platform === "win32") {
    // Pair with Git/MSYS OpenSSH when present (same stack as user-mode ssh-agent).
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA || "";
    const userProfile = env.USERPROFILE || "";
    for (const candidate of [
      path.join(programFiles, "Git", "usr", "bin", "ssh-add.exe"),
      path.join(programFilesX86, "Git", "usr", "bin", "ssh-add.exe"),
      path.join(localAppData, "Programs", "Git", "usr", "bin", "ssh-add.exe"),
      path.join(userProfile, "scoop", "apps", "git", "current", "usr", "bin", "ssh-add.exe"),
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  return "ssh-add";
}

async function defaultRunSshAdd(args, { socketPath, env, platform, askpassEnv }) {
  const sshAdd = resolveSshAddBinary(platform, env);
  const mergedEnv = {
    ...env,
    SSH_AUTH_SOCK: socketPath,
    // Prefer a GUI askpass when provided (PIN / touch prompts). Without a TTY
    // OpenSSH falls back to SSH_ASKPASS for ssh-sk-helper.
    ...(askpassEnv || { SSH_ASKPASS_REQUIRE: "never" }),
  };
  // OpenSSH only invokes askpass when stdin is not a TTY; force that here.
  await execFileAsync(sshAdd, args, {
    // Align with FIDO prompt TTL (~180s) so the modal is not left open after failure.
    timeout: 170000,
    windowsHide: true,
    env: mergedEnv,
    // Detach from parent's TTY so SSH_ASKPASS_REQUIRE=force is honored.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const OPENSSH_PRIVATE_KEY_RE =
  /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/;
const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";
const SK_ECDSA_NISTP256 = "sk-ecdsa-sha2-nistp256@openssh.com";

function looksLikeSkPublicKeyText(text) {
  return typeof text === "string"
    && /sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)(?:-cert-v0[01])?@openssh\.com/.test(text);
}

/** True for sk public lines *or* sk private PEMs (type may only exist after base64 decode). */
function looksLikeSkKeyMaterial(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  if (looksLikeSkPublicKeyText(text)) return true;
  const match = OPENSSH_PRIVATE_KEY_RE.exec(text);
  if (!match) return false;
  try {
    const body = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("binary");
    return body.includes(SK_SSH_ED25519) || body.includes(SK_ECDSA_NISTP256);
  } catch {
    return false;
  }
}

async function shouldLoadIdentityFileIntoAgent(identityPath, options, deps) {
  // Explicit opt-in (used for vault-imported FIDO handles).
  if (options.loadIdentityFilesIntoAgent === true) return true;
  // Soft keys continue to use macOS Keychain / user-managed agent flows.
  // Auto-load only FIDO2 sk-* identity files so ssh2 can request hardware
  // signatures without changing AddKeysToAgent policy for regular keys.
  try {
    const pubPath = identityPath.endsWith(".pub") ? identityPath : `${identityPath}.pub`;
    const pub = await deps.readFile(pubPath, "utf8");
    if (looksLikeSkKeyMaterial(pub)) return true;
  } catch {
    // fall through to private-key probe
  }
  try {
    const privateKey = await deps.readFile(identityPath, "utf8");
    if (looksLikeSkKeyMaterial(privateKey)) return true;
  } catch {
    return false;
  }
  return false;
}

async function prepareSystemSshAgent(options, injected = {}) {
  if (!options?.socketPath) return null;
  const deps = {
    createAgent: injected.createAgent ?? createAgent,
    readFile: injected.readFile ?? fs.promises.readFile,
    runSshAdd: injected.runSshAdd,
    platform: injected.platform ?? process.platform,
    env: injected.env ?? process.env,
    log: injected.log,
    askpassEnv: injected.askpassEnv,
  };
  const agent = deps.createAgent(options.socketPath);
  const { preferred, providedPreferredCount, resolvedIdentityPaths, unavailablePublicKeyPaths } = await loadPreferredPublicKeyBlobs(
    options.identityFilePaths,
    options.agentPublicKeys,
    { hostname: options.hostname, port: options.port, username: options.username, env: deps.env },
    deps,
  );

  if (shouldLoadFromMacKeychain(options, deps.platform)) {
    let loadedBlobs = new Set();
    try {
      loadedBlobs = new Set((await getIdentities(agent)).map(publicKeyBlob).filter(Boolean));
    } catch (error) {
      deps.log?.("Could not inspect SSH agent identities before Keychain load", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Without a readable .pub selector we cannot tell whether the configured
    // identity is already loaded, so still ask Apple's ssh-add to load it.
    // In non-strict mode the delegate can then safely advertise the full list.
    const hasEveryPreferredIdentity = unavailablePublicKeyPaths.length === 0
      && preferred.size > 0
      && [...preferred].every((blob) => loadedBlobs.has(blob));
    if (!hasEveryPreferredIdentity) {
      try {
        const args = ["--apple-load-keychain", ...resolvedIdentityPaths];
        if (deps.runSshAdd) await deps.runSshAdd(args);
        else {
          await defaultRunSshAdd(args, {
            socketPath: options.socketPath,
            env: deps.env,
            platform: deps.platform,
            askpassEnv: deps.askpassEnv,
          });
        }
      } catch (error) {
        deps.log?.("macOS Keychain could not load the configured SSH identity", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Load FIDO2 / SK identity files (and other identities when addKeysToAgent is
  // set) into the agent so ssh2 can request hardware signatures.
  /** @type {string[]} Paths newly ssh-add'd this preparation (for shared-agent cleanup). */
  const newlyLoadedIdentityPaths = [];
  /** @type {Array<{ key: string, identityPath: string }>} Identities this prep depends on. */
  const sharedAgentIdentities = [];
  if (resolvedIdentityPaths.length > 0) {
    let loadedBlobs = new Set();
    try {
      loadedBlobs = new Set((await getIdentities(agent)).map(publicKeyBlob).filter(Boolean));
    } catch (error) {
      deps.log?.("Could not inspect SSH agent identities before identity load", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const identityPath of resolvedIdentityPaths) {
      const pubPath = identityPath.endsWith(".pub") ? identityPath : `${identityPath}.pub`;
      const certPath = identityPath.endsWith(".pub") ? null : `${identityPath}-cert.pub`;
      /** @type {string|null} */
      let blob = null;
      /** @type {string|null} */
      let certBlob = null;
      let bareAlreadyPresent = false;
      let companionCertificateMissing = false;
      try {
        const pub = await deps.readFile(pubPath, "utf8");
        blob = publicKeyBlob(pub);
        if (blob && loadedBlobs.has(blob)) bareAlreadyPresent = true;
      } catch {
        // No .pub selector — still attempt ssh-add when requested.
      }
      if (bareAlreadyPresent && certPath) {
        // OpenSSH ssh-add loads `<identity>-cert.pub` with the private handle.
        // If only the bare key is already advertised, still run ssh-add so a
        // staged vault certificate reaches the agent.
        try {
          const certPub = await deps.readFile(certPath, "utf8");
          certBlob = publicKeyBlob(certPub);
          if (certBlob && !loadedBlobs.has(certBlob)) {
            companionCertificateMissing = true;
          }
        } catch {
          // No companion certificate — bare-key skip remains valid.
        }
      }
      if (bareAlreadyPresent && !companionCertificateMissing) {
        // Join refcount only when Netcatty already owns this identity (another
        // session loaded it). Pre-existing user agent identities must not be
        // adopted into cleanup — last release would ssh-add -d them.
        const key = blob || identityPath;
        if (hasSharedAgentIdentity(key)) {
          sharedAgentIdentities.push({ key, identityPath });
        }
        continue;
      }
      if (!(await shouldLoadIdentityFileIntoAgent(identityPath, options, deps))) continue;
      try {
        const args = [identityPath];
        if (deps.runSshAdd) await deps.runSshAdd(args);
        else {
          await defaultRunSshAdd(args, {
            socketPath: options.socketPath,
            env: deps.env,
            platform: deps.platform,
            askpassEnv: deps.askpassEnv,
          });
        }
        if (!blob) {
          try {
            const pub = await deps.readFile(pubPath, "utf8");
            blob = publicKeyBlob(pub);
          } catch {
            // path-keyed fallback below
          }
        }
        if (blob) loadedBlobs.add(blob);
        if (certBlob) loadedBlobs.add(certBlob);
        else if (certPath) {
          try {
            const certPub = await deps.readFile(certPath, "utf8");
            certBlob = publicKeyBlob(certPub);
            if (certBlob) loadedBlobs.add(certBlob);
          } catch {
            // no companion cert
          }
        }
        const key = blob || identityPath;
        if (bareAlreadyPresent) {
          // Reloaded only to advertise a missing companion certificate.
          if (hasSharedAgentIdentity(key)) {
            // Another Netcatty session already owns the bare identity; join its
            // refcount so the last release can ssh-add -d the private handle.
            sharedAgentIdentities.push({ key, identityPath });
          } else if (certBlob && certPath) {
            // Bare key was already in the shared agent (user-managed). Track the
            // certificate alone so cleanup removes only what we added.
            newlyLoadedIdentityPaths.push(certPath);
            sharedAgentIdentities.push({ key: certBlob, identityPath: certPath });
          }
        } else {
          newlyLoadedIdentityPaths.push(identityPath);
          sharedAgentIdentities.push({ key, identityPath });
        }
        deps.log?.("Loaded identity into SSH agent", { identityPath });
      } catch (error) {
        deps.log?.("Could not load identity into SSH agent", {
          identityPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (
    options.identitiesOnly === true
    && (preferred.size === 0 || (unavailablePublicKeyPaths.length > 0 && providedPreferredCount === 0))
  ) {
    // Roll back identities we just added so a failed prep does not leak keys
    // into a shared (e.g. Windows system) agent.
    for (const identityPath of newlyLoadedIdentityPaths) {
      try {
        const args = ["-d", identityPath];
        if (deps.runSshAdd) await deps.runSshAdd(args);
        else {
          await defaultRunSshAdd(args, {
            socketPath: options.socketPath,
            env: deps.env,
            platform: deps.platform,
            askpassEnv: { SSH_ASKPASS_REQUIRE: "never" },
          });
        }
      } catch {
        // ignore
      }
    }
    const error = new Error(
      unavailablePublicKeyPaths.length > 0
        ? `IdentitiesOnly requires a readable public key selector. Missing or invalid: ${unavailablePublicKeyPaths.join(", ")}`
        : "IdentitiesOnly requires at least one IdentityFile with a readable public .pub key.",
    );
    error.code = "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE";
    throw error;
  }

  const wrapped = new IdentityAwareAgent(agent, preferred, options.identitiesOnly === true);
  if (newlyLoadedIdentityPaths.length > 0) {
    wrapped._netcattyNewlyLoadedIdentityPaths = newlyLoadedIdentityPaths;
  }
  if (sharedAgentIdentities.length > 0) {
    wrapped._netcattySharedAgentIdentities = sharedAgentIdentities;
  }
  return wrapped;
}

module.exports = {
  IdentityAwareAgent,
  prepareSystemSshAgent,
  publicKeyBlob,
  resolveIdentityPath,
  resolveSshAddBinary,
  shouldLoadFromMacKeychain,
  shouldLoadIdentityFileIntoAgent,
  retainSharedAgentIdentity,
  releaseSharedAgentIdentity,
  hasSharedAgentIdentity,
  resetSharedAgentIdentityRefsForTests,
};
