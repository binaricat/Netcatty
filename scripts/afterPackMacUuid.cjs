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

/** @param {import('electron-builder').AfterPackContext} context */
async function afterPack(context) {
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
