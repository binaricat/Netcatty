/**
 * electron-builder afterPack hook — give the macOS app a unique Mach-O LC_UUID.
 *
 * macOS keys the "Local Network" privacy permission on the main executable's
 * Mach-O LC_UUID (see Apple TN3179). Electron's prebuilt binary is linked with
 * LLD, which derives the UUID from a content hash, so EVERY app built from the
 * same Electron version ships the *same* LC_UUID — even with a different bundle
 * id. That collision makes the Local Network grant unreliable: macOS may apply
 * another Electron app's decision to ours, so a user who toggles the permission
 * on still gets `EHOSTUNREACH` when connecting to LAN/VMware host-only addresses
 * (issue #1040).
 *
 * This hook rewrites the LC_UUID of the packaged main executable to a value
 * derived deterministically from the appId — stable across builds (so users
 * don't have to re-grant on every update) but distinct from every other app.
 * It runs in `afterPack`, i.e. BEFORE electron-builder code-signs, so the
 * signature/notarization covers the patched binary.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  copyPatchedNodePtyToPackagedApp,
  rebuildPatchedNodePty,
} = require("./nodePtyConptyPatch.cjs");

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf; // thin 64-bit, little-endian on disk
const MH_CIGAM_64 = 0xcffaedfe; // thin 64-bit, byte-swapped
const FAT_MAGIC = 0xcafebabe; // fat, big-endian
const FAT_MAGIC_64 = 0xcafebabf;
const MACH_HEADER_64_SIZE = 32;

/**
 * Deterministic, app-specific 16-byte UUID. Stable across builds (so the
 * Local Network grant survives updates) yet unique per appId.
 * @param {string} appId
 * @returns {Buffer}
 */
function deriveUuid(appId) {
  const hash = crypto.createHash("sha1").update(`netcatty-local-network|${appId}`).digest();
  const uuid = Buffer.from(hash.subarray(0, 16));
  uuid[6] = (uuid[6] & 0x0f) | 0x50; // version 5
  uuid[8] = (uuid[8] & 0x3f) | 0x80; // RFC 4122 variant
  return uuid;
}

function formatUuid(buf) {
  const h = buf.toString("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Patch every LC_UUID load command inside a single thin Mach-O slice.
 * @returns {string[]} the old UUIDs that were replaced (hex)
 */
function patchThinSlice(buf, sliceOffset, uuid) {
  const magic = buf.readUInt32LE(sliceOffset);
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) return [];
  const swapped = magic === MH_CIGAM_64;
  const readU32 = (o) => (swapped ? buf.readUInt32BE(o) : buf.readUInt32LE(o));

  const ncmds = readU32(sliceOffset + 16);
  let off = sliceOffset + MACH_HEADER_64_SIZE;
  const replaced = [];
  for (let i = 0; i < ncmds; i += 1) {
    const cmd = readU32(off);
    const cmdsize = readU32(off + 4);
    if (cmdsize <= 0) break;
    if (cmd === LC_UUID) {
      replaced.push(buf.subarray(off + 8, off + 24).toString("hex"));
      uuid.copy(buf, off + 8); // uuid[16] follows cmd(4) + cmdsize(4)
    }
    off += cmdsize;
  }
  return replaced;
}

/**
 * Rewrite all LC_UUID load commands in a Mach-O buffer (thin or fat) in place.
 * @returns {{ patched: number, oldUuids: string[] }}
 */
function patchMachOBuffer(buf, uuid) {
  const magicBE = buf.readUInt32BE(0);
  const oldUuids = [];

  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const is64 = magicBE === FAT_MAGIC_64;
    const archSize = is64 ? 32 : 20;
    const nfat = buf.readUInt32BE(4);
    for (let i = 0; i < nfat; i += 1) {
      const archOff = 8 + i * archSize;
      const sliceOffset = is64
        ? Number(buf.readBigUInt64BE(archOff + 8))
        : buf.readUInt32BE(archOff + 8);
      oldUuids.push(...patchThinSlice(buf, sliceOffset, uuid));
    }
  } else {
    oldUuids.push(...patchThinSlice(buf, 0, uuid));
  }

  return { patched: oldUuids.length, oldUuids };
}

function patchMachOFile(file, uuid) {
  const buf = fs.readFileSync(file);
  const result = patchMachOBuffer(buf, uuid);
  if (result.patched > 0) fs.writeFileSync(file, buf);
  return result;
}

function adHocSignAppBundle(appPath, options = {}) {
  const hostPlatform = options.hostPlatform || process.platform;
  const execFile = options.execFileSync || execFileSync;

  if (hostPlatform !== "darwin") {
    console.warn(
      `[afterPack] Skipping ad-hoc codesign for ${appPath}; host platform is ${hostPlatform}`,
    );
    return false;
  }

  execFile("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return true;
}

const ELECTRON_BUILDER_ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

function archNameFromContext(context) {
  const arch = context?.arch;
  if (typeof arch === "string") return arch;
  if (typeof arch === "number" && ELECTRON_BUILDER_ARCH_NAMES[arch]) {
    return ELECTRON_BUILDER_ARCH_NAMES[arch];
  }
  return process.arch;
}

function cursorPlatformPackageBases(platform) {
  if (platform === "darwin") return ["sdk-darwin-arm64", "sdk-darwin-x64"];
  if (platform === "linux") return ["sdk-linux-arm64", "sdk-linux-x64"];
  if (platform === "win32") return ["sdk-win32-x64"];
  return [];
}

function cursorPackagesToKeep(platform, archName) {
  if (platform === "darwin" && archName === "universal") {
    return new Set(["sdk-darwin-arm64", "sdk-darwin-x64"]);
  }
  if (platform === "darwin" && (archName === "arm64" || archName === "x64")) {
    return new Set([`sdk-darwin-${archName}`]);
  }
  if (platform === "linux" && (archName === "arm64" || archName === "x64")) {
    return new Set([`sdk-linux-${archName}`]);
  }
  if (platform === "win32" && archName === "x64") {
    return new Set(["sdk-win32-x64"]);
  }
  return new Set();
}

function appResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, sizeBuf.length, 0) !== sizeBuf.length) {
      throw new Error(`[afterPack] Unable to read ASAR header size: ${asarPath}`);
    }

    const sizePicklePayloadSize = sizeBuf.readUInt32LE(0);
    if (sizePicklePayloadSize !== 4) {
      throw new Error(`[afterPack] Unsupported ASAR size pickle in ${asarPath}`);
    }

    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
      throw new Error(`[afterPack] Unable to read ASAR header: ${asarPath}`);
    }

    const headerPicklePayloadSize = headerBuf.readUInt32LE(0);
    if (headerPicklePayloadSize !== headerSize - 4) {
      throw new Error(`[afterPack] Unsupported ASAR header pickle in ${asarPath}`);
    }

    const headerStringLength = headerBuf.readInt32LE(4);
    const headerString = headerBuf.subarray(8, 8 + headerStringLength).toString("utf8");
    return { header: JSON.parse(headerString), headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function writeAsarHeaderPreservingDataOffset(asarPath, header, headerSize) {
  const headerString = JSON.stringify(header);
  const headerStringLength = Buffer.byteLength(headerString);
  const fixedPrefixSize = 8; // payload size uint32 + string length int32
  if (fixedPrefixSize + headerStringLength > headerSize) {
    throw new Error(
      `[afterPack] Updated ASAR header is larger than the original header for ${asarPath}`,
    );
  }

  const headerBuf = Buffer.alloc(headerSize);
  headerBuf.writeUInt32LE(headerSize - 4, 0);
  headerBuf.writeInt32LE(headerStringLength, 4);
  headerBuf.write(headerString, fixedPrefixSize, headerStringLength, "utf8");

  const fd = fs.openSync(asarPath, "r+");
  try {
    fs.writeSync(fd, headerBuf, 0, headerBuf.length, 8);
  } finally {
    fs.closeSync(fd);
  }
}

function removeAsarHeaderEntry(header, entryPath) {
  const segments = entryPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;

  let node = header;
  for (const segment of segments.slice(0, -1)) {
    node = node.files?.[segment];
    if (!node) return false;
  }

  const leaf = segments[segments.length - 1];
  if (!Object.prototype.hasOwnProperty.call(node.files || {}, leaf)) return false;
  delete node.files[leaf];
  return true;
}

function pruneAsarHeaderEntries(asarPath, entryPaths) {
  if (!fs.existsSync(asarPath) || entryPaths.length === 0) return [];

  const { header, headerSize } = readAsarHeader(asarPath);
  const removed = entryPaths.filter((entryPath) => removeAsarHeaderEntry(header, entryPath));
  if (removed.length > 0) {
    writeAsarHeaderPreservingDataOffset(asarPath, header, headerSize);
  }
  return removed;
}

function pruneCursorSdkPlatformPackages(context) {
  const platform = context.electronPlatformName;
  const candidates = cursorPlatformPackageBases(platform);
  if (candidates.length === 0) return [];

  const keep = cursorPackagesToKeep(platform, archNameFromContext(context));
  if (keep.size === 0) return [];

  const cursorRoot = path.join(
    appResourcesDir(context),
    "app.asar.unpacked",
    "node_modules",
    "@cursor",
  );
  if (!fs.existsSync(cursorRoot)) return [];

  const removed = [];
  const asarHeaderEntriesToRemove = [];
  for (const baseName of candidates) {
    if (keep.has(baseName)) continue;
    const dir = path.join(cursorRoot, baseName);
    if (!fs.existsSync(dir)) continue;
    removed.push(baseName);
    asarHeaderEntriesToRemove.push(`node_modules/@cursor/${baseName}`);
  }

  if (removed.length === 0) return [];

  const appAsar = path.join(appResourcesDir(context), "app.asar");
  pruneAsarHeaderEntries(appAsar, asarHeaderEntriesToRemove);

  for (const baseName of removed) {
    fs.rmSync(path.join(cursorRoot, baseName), { recursive: true, force: true });
  }
  return removed;
}

/** @param {import('electron-builder').AfterPackContext} context */
async function afterPack(context) {
  const removedCursorPackages = pruneCursorSdkPlatformPackages(context);
  if (removedCursorPackages.length > 0) {
    console.log(
      `[afterPack] Removed unused Cursor SDK platform package(s): ${removedCursorPackages.join(", ")}`,
    );
  }

  if (context.electronPlatformName === "win32") {
    const projectDir = context.packager.appDir || context.packager.projectDir;
    rebuildPatchedNodePty({ projectDir, platform: "win32", arch: context.arch });
    copyPatchedNodePtyToPackagedApp({
      projectDir,
      resourcesDir: appResourcesDir(context),
    });
    console.log("[afterPack] Installed patched node-pty ConPTY runtime into packaged app");
    return;
  }

  if (context.electronPlatformName !== "darwin") return;

  const appId = context.packager.appInfo.id || "com.netcatty.app";
  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  const exePath = path.join(
    appPath,
    "Contents",
    "MacOS",
    productFilename,
  );

  if (!fs.existsSync(exePath)) {
    throw new Error(`[afterPack] macOS executable not found: ${exePath}`);
  }

  const uuid = deriveUuid(appId);
  const { patched, oldUuids } = patchMachOFile(exePath, uuid);

  if (patched === 0) {
    throw new Error(
      `[afterPack] No LC_UUID load command found in ${exePath} — Local Network UUID fix did not apply`,
    );
  }

  console.log(
    `[afterPack] Mach-O LC_UUID rewritten for Local Network privacy (#1040): ` +
      `${oldUuids.map((h) => formatUuid(Buffer.from(h, "hex"))).join(", ")} -> ${formatUuid(uuid)} ` +
      `(${patched} slice(s), appId=${appId})`,
  );

  // The official Developer ID signing step runs after afterPack and replaces
  // this temporary signature. Local unsigned builds skip that step, so the
  // patched app bundle still needs a valid ad-hoc signature or macOS kills it
  // before Electron can start. Signing the whole bundle also covers Electron's
  // nested frameworks, which codesign validates as subcomponents.
  if (adHocSignAppBundle(appPath)) {
    console.log("[afterPack] Ad-hoc signed patched macOS app for local unsigned builds");
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.deriveUuid = deriveUuid;
module.exports.formatUuid = formatUuid;
module.exports.patchMachOBuffer = patchMachOBuffer;
module.exports.patchMachOFile = patchMachOFile;
module.exports.adHocSignAppBundle = adHocSignAppBundle;
module.exports.readAsarHeader = readAsarHeader;
module.exports.pruneAsarHeaderEntries = pruneAsarHeaderEntries;
module.exports.pruneCursorSdkPlatformPackages = pruneCursorSdkPlatformPackages;
