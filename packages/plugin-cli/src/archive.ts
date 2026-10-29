import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import { inspectPluginBrandIcon, PLUGIN_BRAND_ICON_MAX_BYTES } from "@netcatty/plugin-contract";
import type { IconReference, PluginManifest } from "@netcatty/plugin-contract";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { IGNORED_ROOT_ENTRIES, PACKAGE_LIMITS } from "./constants.js";
import {
  parseAndValidateManifestContents,
  readValidatedManifestSource,
  type ValidatedManifestSource,
} from "./manifest.js";
import { assertSafePackagePath, PackagePathRegistry } from "./packagePath.js";

const CRC32_TABLE = new Uint32Array(256);
const EXECUTABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".exe", ".ps1"]);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly packagePath: string;
  readonly size: number;
  readonly crc32: number;
  readonly sha256: string;
  readonly executable: boolean;
}

interface ScannedManifestIdentity {
  readonly size: number;
  readonly sha256: string;
}

export function assertManifestSnapshotMatches(
  source: Pick<ValidatedManifestSource, "size" | "sha256">,
  scanned: ScannedManifestIdentity | undefined,
): void {
  if (!scanned || scanned.size !== source.size || scanned.sha256 !== source.sha256) {
    throw new Error("Plugin manifest changed after validation");
  }
}

export interface PackageBuildResult {
  readonly outputPath: string;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly archiveBytes: number;
  readonly sha256: string;
  readonly contentSha256: string;
}

export interface PackageValidationResult {
  readonly manifest: PluginManifest;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly contentSha256: string;
}

export type PluginDirectoryValidationResult = PackageValidationResult;

function updateCrc32(current: number, chunk: Buffer): number {
  let crc = current;
  for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

async function readRegularFile(
  filePath: string,
  maxBytes: number,
  onChunk: (chunk: Buffer) => void,
): Promise<{ size: number; mode: number }> {
  const noFollow = "O_NOFOLLOW" in constants
    ? constants.O_NOFOLLOW
    : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error(`Package source is not a regular file: ${filePath}`);
    let size = 0;
    const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        throw new Error(`Package source exceeds ${maxBytes} bytes while reading: ${filePath}`);
      }
      onChunk(buffer);
    }
    return { size, mode: fileStats.mode };
  } finally {
    await handle.close();
  }
}

export async function hashFile(
  filePath: string,
  maxBytes: number,
): Promise<{ crc32: number; sha256: string; size: number; mode: number }> {
  const sha256 = createHash("sha256");
  let crc = 0xffffffff;
  const file = await readRegularFile(filePath, maxBytes, (buffer) => {
    sha256.update(buffer);
    crc = updateCrc32(crc, buffer);
  });
  return {
    crc32: (crc ^ 0xffffffff) >>> 0,
    sha256: sha256.digest("hex"),
    size: file.size,
    mode: file.mode,
  };
}

function sortPackagePaths(left: ScannedFile, right: ScannedFile): number {
  return Buffer.compare(Buffer.from(left.packagePath), Buffer.from(right.packagePath));
}

interface PackageContentIdentity {
  readonly packagePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

/**
 * Hash the logical package contents instead of the ZIP representation. This
 * keeps integrity checks stable across valid ZIP encoders and compression
 * choices while binding every path, byte length, executable bit, and file
 * digest into one versioned identity.
 */
export function computePackageContentSha256(
  entries: readonly PackageContentIdentity[],
): string {
  const hash = createHash("sha256");
  hash.update("netcatty-plugin-content-v1\0", "utf8");
  const ordered = [...entries].sort((left, right) => (
    Buffer.compare(Buffer.from(left.packagePath), Buffer.from(right.packagePath))
  ));
  for (const entry of ordered) {
    const packagePath = Buffer.from(entry.packagePath, "utf8");
    const header = Buffer.allocUnsafe(13);
    header.writeUInt32BE(packagePath.byteLength, 0);
    header.writeBigUInt64BE(BigInt(entry.size), 4);
    header.writeUInt8(entry.executable ? 1 : 0, 12);
    hash.update(header);
    hash.update(packagePath);
    hash.update(Buffer.from(entry.sha256, "hex"));
  }
  return hash.digest("hex");
}

function isExecutablePackageFile(packagePath: string, mode: number): boolean {
  return (mode & 0o111) !== 0
    || EXECUTABLE_EXTENSIONS.has(path.posix.extname(packagePath).toLowerCase());
}

function packageIconPaths(icon: IconReference | undefined): string[] {
  if (icon?.kind !== "package") return [];
  return icon.dark
    ? [icon.light, icon.dark]
    : [icon.light];
}

function isSameOrDescendantPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}

async function resolveThroughExistingAncestor(targetPath: string): Promise<string> {
  let currentPath = targetPath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const resolvedAncestor = await realpath(currentPath);
      return path.join(resolvedAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function scanPackageDirectory(
  pluginDirectory: string,
  manifestSource: ValidatedManifestSource,
  options: { allowIgnoredRootEntries?: boolean } = {},
): Promise<ScannedFile[]> {
  const { manifest } = manifestSource;
  const registry = new PackagePathRegistry();
  const companionPaths = new Map(
    (manifest.companionExecutables ?? []).flatMap((companion) => (
      companion.variants.map((variant) => [variant.path, variant] as const)
    )),
  );
  const files: ScannedFile[] = [];
  let totalBytes = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (
        relativeDirectory === ""
        && (IGNORED_ROOT_ENTRIES.has(entry.name) || entry.name.endsWith(".ncpkg"))
      ) {
        if (options.allowIgnoredRootEntries === false) {
          throw new Error(`Installed plugin contains an unpackaged root entry: ${entry.name}`);
        }
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const packagePath = assertSafePackagePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      const fileStats = await lstat(absolutePath);
      if (fileStats.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in plugin packages: ${packagePath}`);
      }
      if (fileStats.isDirectory()) {
        await visit(absolutePath, packagePath);
        continue;
      }
      if (!fileStats.isFile()) {
        throw new Error(`Only regular files are allowed in plugin packages: ${packagePath}`);
      }
      registry.add(packagePath);
      if (files.length + 1 > PACKAGE_LIMITS.fileCount) {
        throw new Error(`Plugin package exceeds ${PACKAGE_LIMITS.fileCount} files`);
      }
      if (fileStats.size > PACKAGE_LIMITS.singleFileBytes) {
        throw new Error(`Plugin file exceeds ${PACKAGE_LIMITS.singleFileBytes} bytes: ${packagePath}`);
      }
      totalBytes += fileStats.size;
      if (totalBytes > PACKAGE_LIMITS.uncompressedBytes) {
        throw new Error(
          `Plugin package exceeds ${PACKAGE_LIMITS.uncompressedBytes} uncompressed bytes`,
        );
      }
      const hashes = await hashFile(absolutePath, PACKAGE_LIMITS.singleFileBytes);
      if (hashes.size !== fileStats.size || hashes.mode !== fileStats.mode) {
        throw new Error(`Package source changed while it was being scanned: ${packagePath}`);
      }
      const isExecutable = isExecutablePackageFile(packagePath, hashes.mode);
      if (isExecutable && !companionPaths.has(packagePath)) {
        throw new Error(`Executable file is not declared as a companion: ${packagePath}`);
      }
      const companion = companionPaths.get(packagePath);
      if (companion && companion.sha256 !== hashes.sha256) {
        throw new Error(`Companion SHA-256 mismatch: ${packagePath}`);
      }
      files.push({
        absolutePath,
        packagePath,
        size: fileStats.size,
        executable: Boolean(companion),
        crc32: hashes.crc32,
        sha256: hashes.sha256,
      });
    }
  }

  await visit(pluginDirectory, "");
  assertManifestSnapshotMatches(
    manifestSource,
    files.find(({ packagePath }) => packagePath === "netcatty.plugin.json"),
  );
  const packagedPaths = new Set(files.map(({ packagePath }) => packagePath));
  const requiredPaths = [
    "netcatty.plugin.json",
    ...packageIconPaths(manifest.icon),
    manifest.main.browser,
    manifest.main.node,
    ...(manifest.contributes?.themes ?? []).map(({ entry }) => entry),
    ...(manifest.contributes?.commands ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.menus ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.views ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...companionPaths.keys(),
  ].filter((entryPath): entryPath is string => Boolean(entryPath));
  for (const requiredPath of requiredPaths) {
    if (!packagedPaths.has(requiredPath)) {
      throw new Error(`Manifest references a missing package file: ${requiredPath}`);
    }
  }
  for (const iconPath of packageIconPaths(manifest.icon)) {
    const file = files.find((entry) => entry.packagePath === iconPath)!;
    if (file.size > PLUGIN_BRAND_ICON_MAX_BYTES) throw new Error('Plugin brand icon exceeds size limit');
    const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== file.size) throw new Error('Brand icon changed during packaging');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Brand icon changed during packaging');
      inspectPluginBrandIcon(bytes, iconPath);
    } finally { await handle.close(); }
  }
  return files.sort(sortPackagePaths);
}

function makeLocalHeader(file: ScannedFile): Buffer {
  const name = Buffer.from(file.packagePath, "utf8");
  const header = Buffer.alloc(30 + name.byteLength);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(file.crc32, 14);
  header.writeUInt32LE(file.size, 18);
  header.writeUInt32LE(file.size, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function makeCentralHeader(file: ScannedFile, localOffset: number): Buffer {
  const name = Buffer.from(file.packagePath, "utf8");
  const header = Buffer.alloc(46 + name.byteLength);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(file.crc32, 16);
  header.writeUInt32LE(file.size, 20);
  header.writeUInt32LE(file.size, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const mode = file.executable ? 0o100755 : 0o100644;
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  name.copy(header, 46);
  return header;
}

function makeEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function writeBuffer(output: ReturnType<typeof createWriteStream>, buffer: Buffer) {
  if (!output.write(buffer)) await once(output, "drain");
}

async function writeArchive(files: readonly ScannedFile[], outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  const centralHeaders: Buffer[] = [];
  let offset = 0;
  try {
    await once(output, "open");
    for (const file of files) {
      const localHeader = makeLocalHeader(file);
      centralHeaders.push(makeCentralHeader(file, offset));
      await writeBuffer(output, localHeader);
      offset += localHeader.byteLength;
      const sha256 = createHash("sha256");
      let crc = 0xffffffff;
      let writtenBytes = 0;
      const input = await open(
        file.absolutePath,
        constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      );
      try {
        const inputStats = await input.stat();
        if (!inputStats.isFile() || inputStats.size !== file.size) {
          throw new Error(`Package source changed before archive write: ${file.packagePath}`);
        }
        const stream = createReadStream(file.absolutePath, { fd: input.fd, autoClose: false });
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          writtenBytes += buffer.byteLength;
          if (writtenBytes > file.size) {
            throw new Error(`Package source changed while it was being written: ${file.packagePath}`);
          }
          sha256.update(buffer);
          crc = updateCrc32(crc, buffer);
          await writeBuffer(output, buffer);
          offset += buffer.byteLength;
        }
      } finally {
        await input.close();
      }
      if (
        writtenBytes !== file.size
        || ((crc ^ 0xffffffff) >>> 0) !== file.crc32
        || sha256.digest("hex") !== file.sha256
      ) {
        throw new Error(`Package source changed while it was being written: ${file.packagePath}`);
      }
    }
    const centralOffset = offset;
    for (const centralHeader of centralHeaders) {
      await writeBuffer(output, centralHeader);
      offset += centralHeader.byteLength;
    }
    await writeBuffer(
      output,
      makeEndOfCentralDirectory(files.length, offset - centralOffset, centralOffset),
    );
    output.end();
    await once(output, "close");
    const archiveStats = await stat(temporaryPath);
    if (archiveStats.size > PACKAGE_LIMITS.archiveBytes) {
      throw new Error(`Plugin archive exceeds ${PACKAGE_LIMITS.archiveBytes} bytes`);
    }
    await rename(temporaryPath, outputPath);
  } catch (error) {
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function buildPluginPackage(
  pluginDirectory: string,
  outputPath: string,
): Promise<PackageBuildResult> {
  const sourceDirectory = path.resolve(pluginDirectory);
  const resolvedOutputPath = path.resolve(outputPath);
  if (!resolvedOutputPath.endsWith(".ncpkg")) {
    throw new Error("Plugin package output must use the .ncpkg extension");
  }
  const canonicalSourceDirectory = await realpath(sourceDirectory);
  const canonicalOutputPath = await resolveThroughExistingAncestor(resolvedOutputPath);
  if (
    isSameOrDescendantPath(sourceDirectory, resolvedOutputPath)
    || isSameOrDescendantPath(canonicalSourceDirectory, canonicalOutputPath)
  ) {
    throw new Error("Plugin package output must be outside the plugin source directory");
  }
  const manifestSource = await readValidatedManifestSource(sourceDirectory);
  const files = await scanPackageDirectory(sourceDirectory, manifestSource);
  await writeArchive(files, resolvedOutputPath);
  const outputStats = await stat(resolvedOutputPath);
  const archiveHash = await hashFile(resolvedOutputPath, PACKAGE_LIMITS.archiveBytes);
  return {
    outputPath: resolvedOutputPath,
    fileCount: files.length,
    uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
    archiveBytes: outputStats.size,
    sha256: archiveHash.sha256,
    contentSha256: computePackageContentSha256(files),
  };
}

export async function validatePluginDirectory(
  pluginDirectory: string,
  options: { allowIgnoredRootEntries?: boolean } = {},
): Promise<PluginDirectoryValidationResult> {
  const sourceDirectory = path.resolve(pluginDirectory);
  const manifestSource = await readValidatedManifestSource(sourceDirectory);
  const files = await scanPackageDirectory(sourceDirectory, manifestSource, options);
  return {
    manifest: manifestSource.manifest,
    fileCount: files.length,
    uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
    contentSha256: computePackageContentSha256(files),
  };
}

function openZip(filePath: string, autoClose = true): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      // Security invariant: for deflated entries, validateEntrySizes inserts an
      // AssertByteCountStream that rejects an overflowing chunk before it is
      // forwarded to readEntry(). Combined with the metadata limits below,
      // captured manifest contents cannot exceed PACKAGE_LIMITS.manifestBytes.
      { lazyEntries: true, autoClose, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(error ?? new Error("Unable to open plugin archive"));
        else resolve(zipFile);
      },
    );
  });
}

interface ReadArchiveEntryResult {
  readonly bytes: number;
  readonly crc32: number;
  readonly sha256: string;
  readonly contents?: Buffer;
}

interface LocalFileHeader {
  readonly generalPurposeBitFlag: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly fileName: Buffer;
}

interface ZipEntryWithRawName extends Entry {
  readonly fileNameRaw?: Buffer;
}

interface ZipFileWithLocalHeader extends ZipFile {
  readLocalFileHeader(
    entry: Entry,
    callback: (error: Error | null, header?: LocalFileHeader) => void,
  ): void;
}

function readLocalFileHeader(zipFile: ZipFile, entry: Entry): Promise<LocalFileHeader> {
  return new Promise((resolve, reject) => {
    (zipFile as ZipFileWithLocalHeader).readLocalFileHeader(entry, (error, header) => {
      if (error || !header) {
        reject(error ?? new Error(`Unable to read local ZIP header: ${entry.fileName}`));
      } else {
        resolve(header);
      }
    });
  });
}

async function validateLocalFileHeader(
  zipFile: ZipFile,
  entry: Entry,
  packagePath: string,
): Promise<void> {
  if ((entry.generalPurposeBitFlag & 0x0800) === 0) {
    throw new Error(`ZIP entry name must use UTF-8 encoding: ${packagePath}`);
  }
  if ((entry.generalPurposeBitFlag & 0x0008) !== 0) {
    throw new Error(`ZIP data descriptors are not allowed: ${packagePath}`);
  }
  const centralName = (entry as ZipEntryWithRawName).fileNameRaw;
  if (!centralName || !centralName.equals(Buffer.from(entry.fileName, "utf8"))) {
    throw new Error(`ZIP central entry name is not canonical UTF-8: ${packagePath}`);
  }
  const local = await readLocalFileHeader(zipFile, entry);
  if (!local.fileName.equals(centralName)) {
    throw new Error(`ZIP local and central entry names differ: ${packagePath}`);
  }
  if (local.generalPurposeBitFlag !== entry.generalPurposeBitFlag) {
    throw new Error(`ZIP local and central entry flags differ: ${packagePath}`);
  }
  if (local.compressionMethod !== entry.compressionMethod) {
    throw new Error(`ZIP local and central compression methods differ: ${packagePath}`);
  }
  if (
    local.crc32 !== entry.crc32
    || local.compressedSize !== entry.compressedSize
    || local.uncompressedSize !== entry.uncompressedSize
  ) {
    throw new Error(`ZIP local and central integrity metadata differ: ${packagePath}`);
  }
}

async function readEntry(
  zipFile: ZipFile,
  entry: Entry,
  captureContents: boolean,
  outputPath?: string,
): Promise<ReadArchiveEntryResult> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read archive entry: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
  const chunks: Buffer[] = [];
  const sha256 = createHash("sha256");
  let crc = 0xffffffff;
  let bytes = 0;
  let outputHandle;
  try {
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      outputHandle = await open(outputPath, "wx", 0o600);
    }
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > PACKAGE_LIMITS.singleFileBytes) {
        throw new Error(`Plugin file exceeds size limit: ${entry.fileName}`);
      }
      sha256.update(buffer);
      crc = updateCrc32(crc, buffer);
      if (captureContents) chunks.push(buffer);
      if (outputHandle) {
        let written = 0;
        while (written < buffer.length) {
          const result = await outputHandle.write(buffer, written, buffer.length - written);
          if (result.bytesWritten === 0) {
            throw new Error(`Unable to extract the complete archive entry: ${entry.fileName}`);
          }
          written += result.bytesWritten;
        }
      }
    }
    if (outputHandle) await outputHandle.sync();
    return {
      bytes,
      crc32: (crc ^ 0xffffffff) >>> 0,
      sha256: sha256.digest("hex"),
      contents: captureContents ? Buffer.concat(chunks) : undefined,
    };
  } finally {
    await outputHandle?.close();
  }
}

async function inspectPluginPackage(
  archivePath: string,
  extractionDirectory?: string,
): Promise<PackageValidationResult> {
  const archiveStats = await stat(archivePath);
  if (archiveStats.size > PACKAGE_LIMITS.archiveBytes) {
    throw new Error(`Plugin archive exceeds ${PACKAGE_LIMITS.archiveBytes} bytes`);
  }
  const zipFile = await openZip(archivePath, false);
  try {
  const registry = new PackagePathRegistry();
  const entries = new Map<string, {
    zipEntry: Entry;
    contents?: Buffer;
    mode: number;
    sha256: string;
    size: number;
  }>();
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zipFile.close();
      reject(error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", resolve);
    zipFile.on("entry", (entry: Entry) => {
      void (async () => {
        try {
          const packagePath = registry.add(entry.fileName);
          if (entries.size + 1 > PACKAGE_LIMITS.fileCount) {
            throw new Error(`Plugin package exceeds ${PACKAGE_LIMITS.fileCount} files`);
          }
          if ((entry.generalPurposeBitFlag & 1) !== 0) {
            throw new Error(`Encrypted ZIP entries are not allowed: ${packagePath}`);
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            throw new Error(`Unsupported ZIP compression method: ${packagePath}`);
          }
          await validateLocalFileHeader(zipFile, entry, packagePath);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = mode & 0o170000;
          if (fileType !== 0 && fileType !== 0o100000) {
            throw new Error(`Only regular files are allowed: ${packagePath}`);
          }
          if (entry.uncompressedSize > PACKAGE_LIMITS.singleFileBytes) {
            throw new Error(`Plugin file exceeds size limit: ${packagePath}`);
          }
          if (
            packagePath === "netcatty.plugin.json"
            && entry.uncompressedSize > PACKAGE_LIMITS.manifestBytes
          ) {
            throw new Error(`Plugin manifest exceeds ${PACKAGE_LIMITS.manifestBytes} bytes`);
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > PACKAGE_LIMITS.uncompressedBytes) {
            throw new Error("Plugin package exceeds the uncompressed size limit");
          }
          const result = await readEntry(
            zipFile,
            entry,
            packagePath === "netcatty.plugin.json",
            extractionDirectory ? path.join(extractionDirectory, ...packagePath.split("/")) : undefined,
          );
          if (result.bytes !== entry.uncompressedSize || result.crc32 !== entry.crc32) {
            throw new Error(`ZIP entry integrity check failed: ${packagePath}`);
          }
          entries.set(packagePath, {
            zipEntry: entry,
            contents: result.contents,
            mode,
            sha256: result.sha256,
            size: result.bytes,
          });
          zipFile.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zipFile.readEntry();
  });

  const manifestEntry = entries.get("netcatty.plugin.json");
  if (!manifestEntry?.contents) throw new Error("Plugin package is missing netcatty.plugin.json");
  const manifest = parseAndValidateManifestContents(manifestEntry.contents);
  const declaredCompanions = new Map(
    (manifest.companionExecutables ?? []).flatMap((companion) => (
      companion.variants.map((variant) => [variant.path, variant] as const)
    )),
  );
  for (const [packagePath, entry] of entries) {
    const isExecutable = isExecutablePackageFile(packagePath, entry.mode);
    if (isExecutable && !declaredCompanions.has(packagePath)) {
      throw new Error(`Executable file is not declared as a companion: ${packagePath}`);
    }
  }
  const requiredPaths = [
    ...packageIconPaths(manifest.icon),
    manifest.main.browser,
    manifest.main.node,
    ...(manifest.contributes?.themes ?? []).map(({ entry }) => entry),
    ...(manifest.contributes?.commands ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.menus ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
    ...(manifest.contributes?.views ?? []).flatMap(({ icon }) => packageIconPaths(icon)),
  ].filter((entryPath): entryPath is string => Boolean(entryPath));
  for (const requiredPath of requiredPaths) {
    if (!entries.has(requiredPath)) {
      throw new Error(`Manifest references a missing package file: ${requiredPath}`);
    }
  }
  // The manifest may follow its assets in ZIP order. Keep the same verified
  // descriptor open, then capture only the (at most two) declared brand images.
  // Non-logo images remain streamed regardless of extension or size.
  for (const iconPath of new Set(packageIconPaths(manifest.icon))) {
    const record = entries.get(iconPath);
    if (!record || record.size > PLUGIN_BRAND_ICON_MAX_BYTES) throw new Error('Brand icon is missing or exceeds size limit');
    const result = await readEntry(zipFile, record.zipEntry, true);
    if (!result.contents || result.sha256 !== record.sha256 || result.bytes !== record.size
      || result.crc32 !== record.zipEntry.crc32) throw new Error('Brand icon changed during archive validation');
    inspectPluginBrandIcon(result.contents, iconPath);
  }
  for (const [companionPath, companion] of declaredCompanions) {
    const entry = entries.get(companionPath);
    if (!entry) throw new Error(`Manifest references a missing companion: ${companionPath}`);
    if (entry.sha256 !== companion.sha256) {
      throw new Error(`Companion SHA-256 mismatch: ${companionPath}`);
    }
  }
  if (extractionDirectory) {
    for (const [packagePath] of entries) {
      await chmod(
        path.join(extractionDirectory, ...packagePath.split("/")),
        declaredCompanions.has(packagePath) ? 0o700 : 0o600,
      );
    }
  }
  const contentSha256 = computePackageContentSha256(
    [...entries].map(([packagePath, entry]) => ({
      packagePath,
      size: entry.size,
      sha256: entry.sha256,
      executable: declaredCompanions.has(packagePath),
    })),
  );
  return { manifest, fileCount: entries.size, uncompressedBytes: totalBytes, contentSha256 };
  } finally { zipFile.close(); }
}

export async function validatePluginPackage(
  archivePath: string,
): Promise<PackageValidationResult> {
  return inspectPluginPackage(archivePath);
}

/**
 * Validates and extracts an immutable package snapshot into a new directory.
 * Failed or incomplete destinations are always removed so only callers that
 * receive a successful result can atomically publish the staged directory.
 */
export async function extractPluginPackage(
  archivePath: string,
  destinationDirectory: string,
): Promise<PackageValidationResult> {
  await mkdir(destinationDirectory, { recursive: false, mode: 0o700 });
  try {
    return await inspectPluginPackage(archivePath, destinationDirectory);
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true });
    throw error;
  }
}
