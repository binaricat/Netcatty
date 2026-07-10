#!/usr/bin/env node
/* eslint-disable no-console */
//
// Download platform-specific mosh-client binaries from binaricat/MoshCatty
// releases into resources/mosh/, so electron-builder can bundle them via
// extraResources.
//
// Layout (MoshCatty only — pure single binary per platform, no Cygwin DLLs,
// no terminfo bag):
//   mosh-client-linux-x64.tar.gz      -> resources/mosh/linux-x64/mosh-client
//   mosh-client-linux-arm64.tar.gz    -> resources/mosh/linux-arm64/mosh-client
//   mosh-client-darwin-universal.tar.gz -> resources/mosh/darwin-universal/mosh-client
//   mosh-client-win32-x64.tar.gz      -> resources/mosh/win32-x64/mosh-client.exe
//
// Usage:
//   node scripts/fetch-mosh-binaries.cjs
//   node scripts/fetch-mosh-binaries.cjs --platform=darwin --arch=universal
//   node scripts/fetch-mosh-binaries.cjs --host --resolve-release
//
// Env:
//   MOSH_BIN_RELEASE          — required for fetch unless --resolve-release
//   MOSH_BIN_OWNER / MOSH_BIN_REPO — default binaricat / MoshCatty
//   MOSH_BIN_BASE_URL         — full release download base override
//   MOSH_BIN_RES_DIR          — output dir override (tests)
//   MOSH_BIN_ALLOW_UNVERIFIED — accept missing SHA256SUMS (local mirrors only)

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  main: resolveMoshBinRelease,
  validateReleaseTag,
} = require("./resolve-mosh-bin-release.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RES_DIR = path.join(ROOT, "resources", "mosh");

const TARGETS = [
  {
    platform: "linux", arch: "x64",
    file: "mosh-client-linux-x64.tar.gz", localDir: "linux-x64", binary: "mosh-client",
  },
  {
    platform: "linux", arch: "arm64",
    file: "mosh-client-linux-arm64.tar.gz", localDir: "linux-arm64", binary: "mosh-client",
  },
  {
    platform: "darwin", arch: "universal",
    file: "mosh-client-darwin-universal.tar.gz", localDir: "darwin-universal", binary: "mosh-client",
  },
  {
    platform: "win32", arch: "x64",
    file: "mosh-client-win32-x64.tar.gz", localDir: "win32-x64", binary: "mosh-client.exe",
  },
];

function log(msg) { console.log(`[fetch-mosh-binaries] ${msg}`); }
function warn(msg) { console.warn(`[fetch-mosh-binaries] WARN ${msg}`); }

function transferFor(url) {
  const protocol = new URL(url).protocol;
  if (protocol === "https:") return https;
  if (protocol === "http:") return http;
  throw new Error(`unsupported protocol for ${url}`);
}

function follow(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("too many redirects"));
    transferFor(url).get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(follow(new URL(res.headers.location, url).toString(), depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parseSums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?\s*(\S+)\s*$/i);
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

async function fetchSums(baseUrl, { allowUnverified = false } = {}) {
  try {
    const buf = await follow(`${baseUrl}/SHA256SUMS`);
    return parseSums(buf.toString("utf8"));
  } catch (err) {
    if (allowUnverified) {
      warn(`could not fetch SHA256SUMS from ${baseUrl} (${err.message})`);
      return new Map();
    }
    throw new Error(`could not fetch SHA256SUMS from ${baseUrl} (${err.message})`);
  }
}

function assertSafeTarEntry(entry) {
  const name = entry.trim();
  if (!name) throw new Error("tarball contains an empty entry name");
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`tarball contains an absolute path: ${name}`);
  }
  if (name.includes("\\")) {
    throw new Error(`tarball contains a Windows-style path: ${name}`);
  }
  const parts = name.split("/");
  if (parts.includes("..")) {
    throw new Error(`tarball contains a parent-directory path: ${name}`);
  }
}

function resolveTarArchiveInvocation(archivePath, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  return {
    cwd: pathApi.dirname(archivePath),
    archive: pathApi.basename(archivePath),
  };
}

function listTarEntries(archivePath) {
  const { cwd, archive } = resolveTarArchiveInvocation(archivePath);
  const out = execFileSync("tar", ["-tzf", archive], { cwd, encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

function validateTarEntries(entries) {
  if (entries.length === 0) throw new Error("tarball is empty");
  for (const entry of entries) assertSafeTarEntry(entry);
}

function chmodExecutable(filePath) {
  if (process.platform !== "win32" && fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()) {
    try { fs.chmodSync(filePath, 0o755); } catch { /* ignore */ }
  }
}

function parseMoshBinRepository(env) {
  // Canonical default binaricat/MoshCatty — never inherit fork owner from
  // GITHUB_REPOSITORY (same policy as resolve-mosh-bin-release).
  return {
    owner: env.MOSH_BIN_OWNER || "binaricat",
    repo: env.MOSH_BIN_REPO || "MoshCatty",
  };
}

function resolveHostTarget(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  if (platform === "darwin") return { platform: "darwin", arch: "universal" };
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return { platform, arch };
  if (platform === "win32" && arch === "x64") return { platform, arch };
  throw new Error(`No bundled mosh-client target for ${platform}-${arch}`);
}

function assertExtractedTreeSafe(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error(`tarball contains a symbolic link: ${path.relative(root, file)}`);
      }
      if (stat.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`tarball contains an unsupported file type: ${path.relative(root, file)}`);
      }
    }
  }
}

/** Keep only the pure MoshCatty client binary under extractDir. */
function normalizeMoshCattyBundle(extractDir, target) {
  const wanted = target.binary;
  const candidates = [
    path.join(extractDir, wanted),
    path.join(extractDir, `mosh-client-${target.platform}-${target.arch}${wanted.endsWith(".exe") ? ".exe" : ""}`),
    path.join(extractDir, wanted.endsWith(".exe") ? "mosh-client.exe" : "mosh-client"),
  ];
  let found = candidates.find((p) => fs.existsSync(p) && fs.lstatSync(p).isFile());
  if (!found) {
    // Search one level deep for a correctly named binary
    for (const name of fs.readdirSync(extractDir)) {
      const child = path.join(extractDir, name);
      if (!fs.statSync(child).isDirectory()) continue;
      const nested = path.join(child, wanted);
      if (fs.existsSync(nested) && fs.lstatSync(nested).isFile()) {
        found = nested;
        break;
      }
    }
  }
  if (!found) {
    throw new Error(`${target.file} did not contain ${wanted}`);
  }

  // Stage a clean tree with only the client binary (drop any accidental extras).
  const cleanDir = path.join(extractDir, ".moshcatty-clean");
  fs.mkdirSync(cleanDir, { recursive: true });
  const destBinary = path.join(cleanDir, wanted);
  fs.copyFileSync(found, destBinary);
  chmodExecutable(destBinary);

  for (const name of fs.readdirSync(extractDir)) {
    if (name === ".moshcatty-clean") continue;
    fs.rmSync(path.join(extractDir, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(cleanDir)) {
    fs.renameSync(path.join(cleanDir, name), path.join(extractDir, name));
  }
  fs.rmSync(cleanDir, { recursive: true, force: true });
}

function replaceDir(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  try {
    fs.renameSync(srcDir, destDir);
  } catch (err) {
    if (!err || err.code !== "EXDEV") throw err;
    fs.cpSync(srcDir, destDir, { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
}

function unpackTarGz(buf, target, { resDir }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-"));
  const archive = path.join(tmpRoot, "bundle.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");
  const destDir = path.join(resDir, target.localDir);
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    fs.writeFileSync(archive, buf);
    validateTarEntries(listTarEntries(archive));
    const archiveInvocation = resolveTarArchiveInvocation(archive);
    execFileSync("tar", ["-xzf", archiveInvocation.archive, "-C", path.basename(extractDir)], {
      cwd: archiveInvocation.cwd,
      stdio: "inherit",
    });
    assertExtractedTreeSafe(extractDir);
    normalizeMoshCattyBundle(extractDir, target);
    replaceDir(extractDir, destDir);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return destDir;
}

async function fetchOne(target, sums, opts) {
  const { baseUrl, resDir, allowUnverified = false } = opts;
  const url = `${baseUrl}/${target.file}`;
  let buf;
  try {
    buf = await follow(url);
  } catch (err) {
    throw new Error(`download failed for ${target.file}: ${err.message}`);
  }

  const expected = sums.get(target.file);
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (expected && expected !== actual) {
    throw new Error(`SHA256 mismatch for ${target.file}: expected ${expected}, got ${actual}`);
  }
  if (!expected) {
    if (!allowUnverified) {
      throw new Error(`no SHA256 entry for ${target.file}`);
    }
    warn(`no SHA256 entry for ${target.file} - accepting actual ${actual}`);
  }

  const destDir = unpackTarGz(buf, target, { resDir });
  log(`unpacked ${target.file} into ${path.relative(ROOT, destDir)}/ (sha256=${actual})`);
  return true;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const platformArg = (argv.find((a) => a.startsWith("--platform=")) || "").split("=")[1];
  const archArg = (argv.find((a) => a.startsWith("--arch=")) || "").split("=")[1];
  let hostTarget = null;
  if (argv.includes("--host")) {
    try {
      hostTarget = resolveHostTarget({ platform: platformArg || process.platform, arch: archArg || process.arch });
    } catch (err) {
      warn(`${err.message} - skipping host mosh-client fetch.`);
      return 0;
    }
  }

  let release = env.MOSH_BIN_RELEASE;
  if (!release && argv.includes("--resolve-release")) {
    release = await resolveMoshBinRelease(env);
  }
  if (!release) {
    log("MOSH_BIN_RELEASE is unset - skipping. Set it (e.g. moshcatty-0.1.4) to bundle mosh-client into the package.");
    return 0;
  }
  // Reject pre-0.1.4 pins (missing the Windows ConPTY shortcut-input fix) even when MOSH_BIN_RELEASE is set
  // without going through --resolve-release.
  release = validateReleaseTag(release);

  const { owner, repo } = parseMoshBinRepository(env);
  const baseUrl = env.MOSH_BIN_BASE_URL ||
    `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release)}`;
  const resDir = path.resolve(env.MOSH_BIN_RES_DIR || DEFAULT_RES_DIR);
  const allowUnverified = env.MOSH_BIN_ALLOW_UNVERIFIED === "true";
  const platformFilter = hostTarget?.platform || platformArg;
  const archFilter = hostTarget?.arch || archArg;

  log(`release=${release} owner=${owner} repo=${repo}`);
  const sums = await fetchSums(baseUrl, { allowUnverified });
  let ok = 0;
  let total = 0;
  for (const target of TARGETS) {
    if (platformFilter && target.platform !== platformFilter) continue;
    if (archFilter && target.arch !== archFilter) continue;
    total += 1;
    if (await fetchOne(target, sums, { baseUrl, resDir, allowUnverified })) ok += 1;
  }
  log(`done - ${ok}/${total} binaries written`);
  if (ok < total) throw new Error(`only wrote ${ok}/${total} requested binaries`);
  return 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[fetch-mosh-binaries] FATAL ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  TARGETS,
  parseMoshBinRepository,
  replaceDir,
  resolveHostTarget,
  resolveTarArchiveInvocation,
  parseSums,
  validateTarEntries,
  assertExtractedTreeSafe,
  normalizeMoshCattyBundle,
  unpackTarGz,
  main,
};
