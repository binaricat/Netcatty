"use strict";

/**
 * External Editor Bridge (Main Process)
 *
 * Responsibilities:
 * 1. Cross-platform auto-detection of installed remote-SSH editors (Zed primary,
 *    plus VS Code, Cursor, Windsurf).
 * 2. Safe installation/removal of the static `Host *.netcatty` OpenSSH config
 *    block in `~/.ssh/config` (zero vault hostnames/keys written to disk).
 * 3. Safe launching of local external editors via structured `spawn(cmd, args, { shell: false })`
 *    after validating remote paths and registering the active SSH session with
 *    `sshChannelBridge` (in `bridge` mode) or formatting a sanitized direct target.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  getSshBridgeDiscoveryFilePath,
  getSshBridgeKnownHostsPath,
  getSshProxyLauncherPath,
} = require("../cli/sshBridgeDiscoveryPath.cjs");
const { ensureHostKeyAndKnownHosts, isValidBridgeHostname } = require("./sshChannelBridge.cjs");

const SSH_CONFIG_MARKER_START = "# >>> Netcatty SSH Bridge >>>";
const SSH_CONFIG_MARKER_END = "# <<< Netcatty SSH Bridge <<<";

const VALID_EDITOR_IDS = new Set(["zed", "vscode", "cursor", "windsurf", "custom"]);
const VALID_KINDS = new Set(["file", "dir", "auto"]);
const MAX_REMOTE_PATH_LENGTH = 2048;

function getDefaultSshConfigPath(homedir = os.homedir()) {
  return path.join(homedir, ".ssh", "config");
}

function quoteSshConfigValue(value) {
  const escaped = String(value || "").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatSshConfigPath(filePath, platform = process.platform) {
  // OpenSSH on Windows handles forward slashes cleanly inside quoted paths
  // and avoids backslash escape ambiguity in ProxyCommand.
  if (platform === "win32") {
    return String(filePath || "").replace(/\\/g, "/");
  }
  return String(filePath || "");
}

function buildSshBridgeConfigBlock({
  proxyLauncherPath,
  knownHostsPath,
  discoveryPath,
  platform = process.platform,
}) {
  const proxyCmdPath = formatSshConfigPath(proxyLauncherPath, platform);
  const khPath = formatSshConfigPath(knownHostsPath, platform);
  const discPath = discoveryPath ? formatSshConfigPath(discoveryPath, platform) : "";
  const proxyCommand = discPath
    ? `${quoteSshConfigValue(proxyCmdPath)} %h ${quoteSshConfigValue(discPath)}`
    : `${quoteSshConfigValue(proxyCmdPath)} %h`;
  return [
    SSH_CONFIG_MARKER_START,
    "Host *.netcatty",
    `    ProxyCommand ${proxyCommand}`,
    `    UserKnownHostsFile ${quoteSshConfigValue(khPath)}`,
    "    StrictHostKeyChecking yes",
    "    IdentitiesOnly yes",
    "    BatchMode yes",
    SSH_CONFIG_MARKER_END,
  ].join("\n");
}

const SAMPLE_BRIDGE_HOSTNAMES = ["a.netcatty", "host-01234567.netcatty"];

function sshGlobToRegExp(pattern) {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") regexStr += ".*";
    else if (ch === "?") regexStr += ".";
    else regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

function tokenizeSshConfigArgs(rawArgs) {
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const ch = rawArgs[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function sshPatternListMatchesHost(patterns, hostname) {
  let matchedPositive = false;
  for (const rawPattern of patterns) {
    if (!rawPattern) continue;
    const negated = rawPattern.startsWith("!");
    const pat = negated ? rawPattern.slice(1) : rawPattern;
    if (!pat) continue;
    if (sshGlobToRegExp(pat).test(hostname)) {
      if (negated) return false;
      matchedPositive = true;
    }
  }
  return matchedPositive;
}

function sshConfigLineMatchesBridgeHost(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const match = /^(host|match)(?:[ \t]+|[ \t]*=[ \t]*)(.+)$/i.exec(trimmed);
  if (!match) return false;
  const directive = match[1].toLowerCase();
  const args = tokenizeSshConfigArgs(match[2].trim());
  if (args.length === 0) return false;

  if (directive === "host") {
    const patterns = args.flatMap((token) => token.split(",").filter(Boolean));
    return SAMPLE_BRIDGE_HOSTNAMES.some((hostname) => sshPatternListMatchesHost(patterns, hostname));
  }

  // `Match` criteria: `Match all` matches everything; if a `host`/`originalhost`
  // criterion is present and cannot match `*.netcatty`, this block won't affect
  // bridge hosts. Otherwise (e.g. `Match final all`, `Match exec ...`, `Match user ...`)
  // conservatively treat it as potentially matching `*.netcatty`.
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const eqIdx = token.indexOf("=");
    const rawKey = (eqIdx === -1 ? token : token.slice(0, eqIdx)).toLowerCase();
    const negatedKey = rawKey.startsWith("!");
    const key = negatedKey ? rawKey.slice(1) : rawKey;
    if (key === "host" || key === "originalhost") {
      const value = eqIdx === -1 ? (args[i + 1] || "") : token.slice(eqIdx + 1);
      if (eqIdx === -1) i += 1;
      const patterns = value.split(",").filter(Boolean);
      const matchesAny = SAMPLE_BRIDGE_HOSTNAMES.some((hostname) =>
        sshPatternListMatchesHost(patterns, hostname),
      );
      if (!negatedKey && !matchesAny) {
        return false;
      }
      if (negatedKey && matchesAny) {
        return false;
      }
    }
  }
  return true;
}

function findFirstMatchingSshConfigBlockIndex(content, limitIndex = content.length) {
  if (typeof content !== "string" || content.length === 0) return -1;
  const bounded = content.slice(0, Math.max(0, Math.min(limitIndex, content.length)));
  let offset = 0;
  while (offset < bounded.length) {
    const nlIndex = bounded.indexOf("\n", offset);
    const lineEnd = nlIndex === -1 ? bounded.length : nlIndex;
    const rawLine = bounded.slice(offset, lineEnd).replace(/\r$/, "");
    if (sshConfigLineMatchesBridgeHost(rawLine)) {
      return offset;
    }
    offset = nlIndex === -1 ? bounded.length : nlIndex + 1;
  }
  return -1;
}

function parseSshBridgeConfigPresence(content) {
  if (typeof content !== "string") return { installed: false, startIndex: -1, endIndex: -1 };
  const startIndex = content.indexOf(SSH_CONFIG_MARKER_START);
  if (startIndex === -1) return { installed: false, startIndex: -1, endIndex: -1 };
  const endMarkerIndex = content.indexOf(SSH_CONFIG_MARKER_END, startIndex);
  if (endMarkerIndex === -1) return { installed: false, startIndex: -1, endIndex: -1 };
  const endIndex = endMarkerIndex + SSH_CONFIG_MARKER_END.length;
  return { installed: true, startIndex, endIndex };
}

function upsertSshBridgeConfigContent(existingContent, block) {
  const rawContent = typeof existingContent === "string" ? existingContent : "";
  const presence = parseSshBridgeConfigPresence(rawContent);
  if (presence.installed) {
    const earlierWildcard = findFirstMatchingSshConfigBlockIndex(rawContent, presence.startIndex);
    if (earlierWildcard === -1) {
      const before = rawContent.slice(0, presence.startIndex);
      const after = rawContent.slice(presence.endIndex);
      return `${before}${block}${after}`;
    }
    // Relocate the existing block ahead of the earlier wildcard/matching rule.
    const stripped = removeSshBridgeConfigContent(rawContent);
    return upsertSshBridgeConfigContent(stripped, block);
  }
  if (!rawContent.trim()) {
    return `${block}\n`;
  }

  const eol = rawContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBlock = eol === "\r\n" ? block.replace(/\r?\n/g, "\r\n") : block;
  const insertBefore = findFirstMatchingSshConfigBlockIndex(rawContent);
  if (insertBefore !== -1) {
    const before = rawContent.slice(0, insertBefore);
    const after = rawContent.slice(insertBefore);
    if (!before) {
      return `${normalizedBlock}${eol}${eol}${after}`;
    }
    const leadingSep = before.endsWith(`${eol}${eol}`)
      ? ""
      : before.endsWith(eol)
        ? eol
        : `${eol}${eol}`;
    return `${before}${leadingSep}${normalizedBlock}${eol}${eol}${after}`;
  }

  const trailing = rawContent.endsWith(eol)
    ? (rawContent.endsWith(`${eol}${eol}`) ? "" : eol)
    : `${eol}${eol}`;
  return `${rawContent}${trailing}${normalizedBlock}${eol}`;
}

function removeSshBridgeConfigContent(existingContent) {
  const content = typeof existingContent === "string" ? existingContent : "";
  const { installed, startIndex, endIndex } = parseSshBridgeConfigPresence(content);
  if (!installed) return content;

  let before = content.slice(0, startIndex);
  let after = content.slice(endIndex);
  // Collapse extra blank lines left behind by removal without touching user content.
  if (after.startsWith("\r\n")) after = after.slice(2);
  else if (after.startsWith("\n")) after = after.slice(1);
  if (before === "") {
    if (after.startsWith("\r\n")) after = after.slice(2);
    else if (after.startsWith("\n")) after = after.slice(1);
  } else if (before.endsWith("\r\n\r\n") && (!after || after.startsWith("\r\n"))) {
    before = before.slice(0, -2);
  } else if (before.endsWith("\n\n") && (!after || after.startsWith("\n"))) {
    before = before.slice(0, -1);
  }
  const combined = `${before}${after}`;
  return combined.trim().length === 0 ? "" : combined;
}

function getSshBridgeConfigStatus(options = {}) {
  const sshConfigPath = options.sshConfigPath || getDefaultSshConfigPath(options.homedir);
  const platform = options.platform || process.platform;
  const proxyLauncherPath = options.proxyLauncherPath || getSshProxyLauncherPath(platform);
  const pathOpts = {
    userDataDir: options.userDataDir,
    stateDir: options.stateDir,
  };
  const knownHostsPath = options.knownHostsPath || getSshBridgeKnownHostsPath(pathOpts);
  const discoveryPath = options.discoveryPath || getSshBridgeDiscoveryFilePath(pathOpts);

  let content = "";
  let configExists = false;
  try {
    if (fs.existsSync(sshConfigPath)) {
      configExists = true;
      content = fs.readFileSync(sshConfigPath, "utf8");
    }
  } catch {
    // unreadable
  }
  const { installed, startIndex } = parseSshBridgeConfigPresence(content);
  const expectedBlock = buildSshBridgeConfigBlock({
    proxyLauncherPath,
    knownHostsPath,
    discoveryPath,
    platform,
  });
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const hasEarlierWildcard = installed && findFirstMatchingSshConfigBlockIndex(content, startIndex) !== -1;
  const upToDate = installed && normalizedContent.includes(expectedBlock) && !hasEarlierWildcard;

  return {
    installed,
    upToDate,
    configExists,
    sshConfigPath,
    proxyLauncherPath,
    knownHostsPath,
    discoveryPath,
  };
}

function installSshBridgeConfig(options = {}) {
  const platform = options.platform || process.platform;
  const sshConfigPath = options.sshConfigPath || getDefaultSshConfigPath(options.homedir);
  const proxyLauncherPath = options.proxyLauncherPath || getSshProxyLauncherPath(platform);
  const pathOpts = {
    userDataDir: options.userDataDir,
    stateDir: options.stateDir,
  };
  const hostKeyInfo = ensureHostKeyAndKnownHosts(pathOpts);
  const knownHostsPath = options.knownHostsPath || hostKeyInfo.knownHostsPath;
  const discoveryPath = options.discoveryPath || getSshBridgeDiscoveryFilePath(pathOpts);

  const sshDir = path.dirname(sshConfigPath);
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      fs.chmodSync(sshDir, 0o700);
    } catch {
      // ignore
    }
  }

  let existing = "";
  try {
    if (fs.existsSync(sshConfigPath)) {
      existing = fs.readFileSync(sshConfigPath, "utf8");
    }
  } catch {
    // ignore
  }

  const block = buildSshBridgeConfigBlock({
    proxyLauncherPath,
    knownHostsPath,
    discoveryPath,
    platform,
  });
  const next = upsertSshBridgeConfigContent(existing, block);

  const tmpPath = `${sshConfigPath}.netcatty-${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, next, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, sshConfigPath);
  if (platform !== "win32") {
    try {
      fs.chmodSync(sshConfigPath, 0o600);
    } catch {
      // ignore
    }
  }

  return getSshBridgeConfigStatus({
    ...options,
    sshConfigPath,
    proxyLauncherPath,
    knownHostsPath,
    discoveryPath,
    platform,
  });
}

function removeSshBridgeConfig(options = {}) {
  const platform = options.platform || process.platform;
  const sshConfigPath = options.sshConfigPath || getDefaultSshConfigPath(options.homedir);
  if (!fs.existsSync(sshConfigPath)) {
    return getSshBridgeConfigStatus({ ...options, sshConfigPath, platform });
  }
  const existing = fs.readFileSync(sshConfigPath, "utf8");
  const next = removeSshBridgeConfigContent(existing);
  if (next !== existing) {
    const tmpPath = `${sshConfigPath}.netcatty-${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, next, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, sshConfigPath);
    if (platform !== "win32") {
      try {
        fs.chmodSync(sshConfigPath, 0o600);
      } catch {
        // ignore
      }
    }
  }
  return getSshBridgeConfigStatus({ ...options, sshConfigPath, platform });
}

// ---------------------------------------------------------------------------
// Cross-platform editor auto-detection
// ---------------------------------------------------------------------------

function findExecutableInPath(names, env = process.env, platform = process.platform, existsSync = fs.existsSync) {
  const pathEnv = env.PATH || env.Path || "";
  if (!pathEnv) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const pathExts = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];

  for (const dir of dirs) {
    for (const name of names) {
      const hasExt = platform === "win32" && /\.[a-z0-9]+$/i.test(name);
      const candidates = hasExt ? [name] : pathExts.map((ext) => `${name}${ext}`);
      for (const candidateName of candidates) {
        const full = path.join(dir, candidateName);
        try {
          if (existsSync(full)) return full;
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

function getEditorCandidatePaths(editorId, { platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const localAppData = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";

  if (platform === "win32") {
    switch (editorId) {
      case "zed":
        return {
          pathNames: ["zed.exe"],
          explicitPaths: [
            path.join(localAppData, "Programs", "Zed", "bin", "zed.exe"),
            path.join(localAppData, "Programs", "Zed", "Zed.exe"),
            path.join(localAppData, "Zed", "Zed.exe"),
            path.join(programFiles, "Zed", "Zed.exe"),
          ],
        };
      case "vscode":
        return {
          pathNames: ["Code.exe"],
          explicitPaths: [
            path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
            path.join(programFiles, "Microsoft VS Code", "Code.exe"),
          ],
        };
      case "cursor":
        return {
          pathNames: ["Cursor.exe"],
          explicitPaths: [
            path.join(localAppData, "Programs", "cursor", "Cursor.exe"),
            path.join(programFiles, "cursor", "Cursor.exe"),
          ],
        };
      case "windsurf":
        return {
          pathNames: ["Windsurf.exe"],
          explicitPaths: [
            path.join(localAppData, "Programs", "Windsurf", "Windsurf.exe"),
            path.join(programFiles, "Windsurf", "Windsurf.exe"),
          ],
        };
      default:
        return { pathNames: [], explicitPaths: [] };
    }
  }

  if (platform === "darwin") {
    switch (editorId) {
      case "zed":
        return {
          pathNames: ["zed"],
          explicitPaths: [
            "/usr/local/bin/zed",
            "/opt/homebrew/bin/zed",
            "/Applications/Zed.app/Contents/MacOS/cli",
            "/Applications/Zed.app",
            path.join(homedir, "Applications", "Zed.app"),
          ],
        };
      case "vscode":
        return {
          pathNames: ["code"],
          explicitPaths: [
            "/usr/local/bin/code",
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Visual Studio Code.app",
          ],
        };
      case "cursor":
        return {
          pathNames: ["cursor"],
          explicitPaths: [
            "/usr/local/bin/cursor",
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
            "/Applications/Cursor.app",
          ],
        };
      case "windsurf":
        return {
          pathNames: ["windsurf"],
          explicitPaths: [
            "/usr/local/bin/windsurf",
            "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
            "/Applications/Windsurf.app",
          ],
        };
      default:
        return { pathNames: [], explicitPaths: [] };
    }
  }

  // Linux / BSD
  switch (editorId) {
    case "zed":
      return {
        pathNames: ["zed", "zeditor"],
        explicitPaths: [
          path.join(homedir, ".local", "bin", "zed"),
          "/usr/local/bin/zed",
          "/usr/bin/zed",
          "/usr/bin/zeditor",
        ],
      };
    case "vscode":
      return {
        pathNames: ["code"],
        explicitPaths: ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"],
      };
    case "cursor":
      return {
        pathNames: ["cursor"],
        explicitPaths: [
          path.join(homedir, ".local", "bin", "cursor"),
          "/usr/bin/cursor",
          "/usr/local/bin/cursor",
        ],
      };
    case "windsurf":
      return {
        pathNames: ["windsurf"],
        explicitPaths: ["/usr/bin/windsurf", "/usr/local/bin/windsurf"],
      };
    default:
      return { pathNames: [], explicitPaths: [] };
  }
}

function detectInstalledEditors(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const existsSync = options.existsSync || fs.existsSync;

  const result = {};
  for (const editorId of ["zed", "vscode", "cursor", "windsurf"]) {
    const { pathNames, explicitPaths } = getEditorCandidatePaths(editorId, { platform, env, homedir });
    let detected = findExecutableInPath(pathNames, env, platform, existsSync);
    if (!detected) {
      for (const candidate of explicitPaths) {
        try {
          if (existsSync(candidate)) {
            detected = candidate;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    result[editorId] = {
      id: editorId,
      detectedPath: detected || null,
      available: Boolean(detected),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Path validation & structured process launching (mirrors domain/externalEditor.ts)
// ---------------------------------------------------------------------------

function validateRemotePath(rawPath) {
  if (typeof rawPath !== "string") throw new Error("Remote path must be a string");
  if (rawPath.length === 0) throw new Error("Remote path is empty");
  if (rawPath.length > MAX_REMOTE_PATH_LENGTH) throw new Error("Remote path is too long");
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error("Remote path contains invalid control characters");
    }
  }
  if (!rawPath.startsWith("/") && rawPath !== "~" && !rawPath.startsWith("~/")) {
    throw new Error("Remote path must be absolute");
  }
  return rawPath;
}

function encodeRemoteSshPath(normalizedPath) {
  if (normalizedPath === "~") return "/~";
  if (normalizedPath.startsWith("~/")) {
    const rest = normalizedPath
      .slice(2)
      .split("/")
      .filter((s) => s.length > 0)
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return rest ? `/~/${rest}` : "/~";
  }
  const clean = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const segments = clean.split("/");
  const encoded = segments
    .map((segment, index) => {
      if (index === 0) return "";
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join("/");
  return encoded || "/";
}

function validateDirectSshTarget(target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("SSH target is empty");
  }
  const trimmed = target.trim();
  if (trimmed.length > 512 || /[\s/\\'"`$;|&<>\r\n\0]/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error("SSH target contains invalid characters");
  }
  return trimmed;
}

function buildLaunchSpec({
  editorId,
  executablePath,
  customArgs,
  sshTarget,
  remotePath,
  kind = "auto",
  platform = process.platform,
}) {
  if (!VALID_EDITOR_IDS.has(editorId)) {
    throw new Error(`Unsupported external editor: ${editorId}`);
  }
  if (typeof executablePath !== "string" || !executablePath.trim()) {
    throw new Error(`No executable path configured or detected for ${editorId}`);
  }
  const cleanExe = executablePath.trim();
  if (/[\r\n\0]/.test(cleanExe)) {
    throw new Error("Executable path contains invalid characters");
  }
  const safeKind = VALID_KINDS.has(kind) ? kind : "auto";
  const encodedPath = encodeRemoteSshPath(remotePath);
  const sshUri = `ssh://${sshTarget}${encodedPath}`;

  let editorArgs;
  let displayUri = sshUri;

  if (editorId === "zed") {
    editorArgs = [sshUri];
  } else if (editorId === "vscode" || editorId === "cursor" || editorId === "windsurf") {
    const vscodeUri = `vscode-remote://ssh-remote+${sshTarget}${encodedPath}`;
    editorArgs = [safeKind === "file" ? "--file-uri" : "--folder-uri", vscodeUri];
    displayUri = vscodeUri;
  } else {
    const template = Array.isArray(customArgs) && customArgs.length > 0
      ? customArgs.filter((item) => typeof item === "string" && item.length > 0 && !/[\r\n\0]/.test(item)).slice(0, 32)
      : ["{sshUri}"];
    if (template.length === 0) template.push("{sshUri}");
    const placeholderValues = {
      "{sshUri}": sshUri,
      "{sshTarget}": sshTarget,
      "{remotePath}": remotePath,
      "{encodedPath}": encodedPath,
      "{kind}": safeKind,
    };
    editorArgs = template.map((token) =>
      token.replace(
        /\{(?:sshUri|sshTarget|remotePath|encodedPath|kind)\}/g,
        (match) => placeholderValues[match],
      ),
    );
  }

  if (platform === "darwin" && /\.app\/?$/i.test(cleanExe)) {
    return {
      command: "open",
      args: ["-a", cleanExe.replace(/\/+$/, ""), "--args", ...editorArgs],
      displayUri,
    };
  }

  // Never pass remote paths through cmd.exe to invoke .cmd/.bat batch launchers
  // on Windows; cmd.exe interprets shell metacharacters (&, |, %, ^, etc.) even
  // when spawned with shell: false. Require a native executable instead.
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cleanExe)) {
    throw new Error(
      "Windows batch launchers (.cmd/.bat) are not supported for remote editor launches. Configure the native .exe executable instead.",
    );
  }

  return {
    command: cleanExe,
    args: editorArgs,
    displayUri,
  };
}

function waitForSpawn(child, requireExitZero = false) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      if (requireExitZero) return;
      cleanup();
      resolve();
    };
    const onClose = (code) => {
      if (!requireExitZero) return;
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`External editor launcher exited with code ${code}`));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (requireExitZero) child.once("close", onClose);
  });
}

function createExternalEditorBridge(options = {}) {
  let userDataDir = options.userDataDir || null;
  let stateDir = options.stateDir || null;
  let sshChannelBridge = options.sshChannelBridge || null;
  let terminalWorkerManager = options.terminalWorkerManager || null;
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform || process.platform;

  function init(deps = {}) {
    if (deps.userDataDir) userDataDir = deps.userDataDir;
    if (deps.stateDir) stateDir = deps.stateDir;
    if (deps.sshChannelBridge) sshChannelBridge = deps.sshChannelBridge;
    if (deps.terminalWorkerManager !== undefined) terminalWorkerManager = deps.terminalWorkerManager;
  }

  async function registerBridgeTarget(payload, webContentsId) {
    if (terminalWorkerManager) {
      return terminalWorkerManager.request("netcatty:ssh-bridge:register-target", payload, {
        webContentsId,
      });
    }
    if (!sshChannelBridge) {
      throw new Error("SSH channel bridge is unavailable");
    }
    return sshChannelBridge.registerTarget(payload);
  }

  async function openRemoteInExternalEditor(payload = {}, context = {}) {
    const editorId = typeof payload.editorId === "string" ? payload.editorId : "zed";
    if (!VALID_EDITOR_IDS.has(editorId)) {
      throw new Error(`Unsupported external editor: ${editorId}`);
    }

    const remotePath = validateRemotePath(payload.remotePath);
    const kind = VALID_KINDS.has(payload.kind) ? payload.kind : "auto";
    const connectionMode = payload.connectionMode === "direct" ? "direct" : "bridge";

    let executablePath = typeof payload.executablePath === "string" ? payload.executablePath.trim() : "";
    if (!executablePath && editorId !== "custom") {
      const detected = detectInstalledEditors({ platform });
      executablePath = detected[editorId]?.detectedPath || "";
    }
    if (!executablePath) {
      throw new Error(`Could not find executable for ${editorId}. Configure its path in Settings.`);
    }

    let sshTarget;
    if (connectionMode === "bridge") {
      const bridgeHost = typeof payload.bridgeHost === "string"
        ? payload.bridgeHost.trim().toLowerCase()
        : "";
      if (!isValidBridgeHostname(bridgeHost)) {
        throw new Error(`Invalid Netcatty SSH bridge host: ${bridgeHost}`);
      }

      // Ensure the static `Host *.netcatty` block is present in `~/.ssh/config`.
      const cfgStatus = getSshBridgeConfigStatus({ userDataDir, stateDir, platform });
      if (!cfgStatus.installed || !cfgStatus.upToDate) {
        installSshBridgeConfig({ userDataDir, stateDir, platform });
      }

      const registration = await registerBridgeTarget({
        bridgeHost,
        sessionId: payload.sessionId || null,
        sftpId: payload.sftpId || null,
        hostId: payload.hostId || null,
        hostname: payload.hostname || "",
        port: payload.port || 22,
        username: payload.username || "",
        ...(userDataDir ? { userDataDir } : {}),
      }, context.webContentsId);

      sshTarget = isValidBridgeHostname(registration?.bridgeHost)
        ? registration.bridgeHost
        : bridgeHost;
    } else {
      sshTarget = validateDirectSshTarget(payload.directSshTarget);
    }

    const spec = buildLaunchSpec({
      editorId,
      executablePath,
      customArgs: payload.customArgs,
      sshTarget,
      remotePath,
      kind,
      platform,
    });

    const isMacOpen = platform === "darwin" && spec.command === "open";
    const child = spawnImpl(spec.command, spec.args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      // Handled via waitForSpawn rejection.
    });
    await waitForSpawn(child, isMacOpen);
    child.unref?.();

    return {
      ok: true,
      editorId,
      sshTarget,
      remotePath,
      displayUri: spec.displayUri,
      connectionMode,
    };
  }

  function registerHandlers(ipcMain, opts = {}) {
    if (opts.terminalWorkerManager !== undefined) {
      terminalWorkerManager = opts.terminalWorkerManager;
    }
    if (opts.sshChannelBridge) {
      sshChannelBridge = opts.sshChannelBridge;
    }

    ipcMain.handle("netcatty:external-editor:detect", async () => {
      return detectInstalledEditors({ platform });
    });

    ipcMain.handle("netcatty:external-editor:bridge-config-status", async () => {
      return getSshBridgeConfigStatus({ userDataDir, stateDir, platform });
    });

    ipcMain.handle("netcatty:external-editor:install-bridge-config", async () => {
      return installSshBridgeConfig({ userDataDir, stateDir, platform });
    });

    ipcMain.handle("netcatty:external-editor:remove-bridge-config", async () => {
      return removeSshBridgeConfig({ userDataDir, stateDir, platform });
    });

    ipcMain.handle("netcatty:external-editor:open-remote", async (event, payload) => {
      return openRemoteInExternalEditor(payload, {
        webContentsId: event?.sender?.id,
      });
    });
  }

  return {
    init,
    openRemoteInExternalEditor,
    registerHandlers,
  };
}

const defaultExternalEditorBridge = createExternalEditorBridge();

module.exports = {
  SSH_CONFIG_MARKER_START,
  SSH_CONFIG_MARKER_END,
  buildSshBridgeConfigBlock,
  parseSshBridgeConfigPresence,
  upsertSshBridgeConfigContent,
  removeSshBridgeConfigContent,
  getSshBridgeConfigStatus,
  installSshBridgeConfig,
  removeSshBridgeConfig,
  detectInstalledEditors,
  buildLaunchSpec,
  createExternalEditorBridge,
  init: defaultExternalEditorBridge.init,
  openRemoteInExternalEditor: defaultExternalEditorBridge.openRemoteInExternalEditor,
  registerHandlers: defaultExternalEditorBridge.registerHandlers,
};
