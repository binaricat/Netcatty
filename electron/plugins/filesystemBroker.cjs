"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { PLUGIN_RPC_MAX_RAW_BYTES } = require("./constants.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_FILESYSTEM_BYTES = PLUGIN_RPC_MAX_RAW_BYTES;
const MAX_DIRECTORY_ENTRIES = 1_000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

function assertAbsolutePath(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw invalidArgument("Plugin filesystem path must be absolute");
  }
  // Resolve absolute paths lexically so permission resources have one stable
  // spelling. In particular, realpath() drops trailing separators, and the
  // post-permission equality checks must compare against the same spelling.
  return path.resolve(value);
}

function assertReadParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem read parameters are invalid");
  }
  const encoding = params.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") {
    throw invalidArgument("Plugin filesystem read encoding is invalid");
  }
  const maxBytes = params.maxBytes ?? MAX_FILESYSTEM_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILESYSTEM_BYTES) {
    throw invalidArgument("Plugin filesystem read limit is invalid");
  }
  return { path: assertAbsolutePath(params.path), encoding, maxBytes };
}

function decodeWriteData(params) {
  const encoding = params.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64") {
    throw invalidArgument("Plugin filesystem write encoding is invalid");
  }
  if (typeof params.data !== "string") throw invalidArgument("Plugin filesystem write data is invalid");
  const bytes = Buffer.from(params.data, encoding);
  if (encoding === "base64" && bytes.toString("base64") !== params.data) {
    throw invalidArgument("Plugin filesystem base64 data is not canonical");
  }
  if (bytes.byteLength > MAX_FILESYSTEM_BYTES) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem write is too large");
  }
  return { encoding, bytes };
}

function assertWriteParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem write parameters are invalid");
  }
  const { encoding, bytes } = decodeWriteData(params);
  if (params.overwrite !== undefined && typeof params.overwrite !== "boolean") {
    throw invalidArgument("Plugin filesystem overwrite flag is invalid");
  }
  return {
    path: assertAbsolutePath(params.path),
    encoding,
    bytes,
    overwrite: params.overwrite === true,
  };
}

function assertSecureWriteMode(value) {
  if (!value.overwrite) {
    throw new PluginRpcError(
      RPC_ERRORS.failedPrecondition,
      "Plugin filesystem writes require explicit overwrite of an existing file",
    );
  }
  return value;
}

function assertPathParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin filesystem parameters are invalid");
  }
  return { path: assertAbsolutePath(params.path) };
}

async function resolveExistingPath(requestedPath, fileSystem = fsp) {
  const canonical = await fileSystem.realpath(requestedPath);
  const stats = await fileSystem.lstat(canonical);
  if (stats.isSymbolicLink()) throw invalidArgument("Plugin filesystem path cannot resolve to a symbolic link");
  return { canonical, stats };
}

async function resolveWritePath(requestedPath, fileSystem = fsp) {
  try {
    const existing = await resolveExistingPath(requestedPath, fileSystem);
    if (!existing.stats.isFile()) throw invalidArgument("Plugin filesystem write target is not a file");
    return existing;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PluginRpcError(
        RPC_ERRORS.failedPrecondition,
        "Plugin filesystem writes require an existing regular file",
      );
    }
    throw error;
  }
}

function entryKind(entry) {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

async function readBoundedFileHandle(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (maxBytes + 1) - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file changed or is too large");
  }
  return Buffer.concat(chunks, total);
}

function assertAuthorizedPath(context, permission, canonical) {
  const authorization = context?.authorization;
  if (
    authorization?.permission !== permission
    || !Array.isArray(authorization.resources)
    || authorization.resources.length !== 1
    || authorization.resources[0] !== canonical
  ) {
    throw new PluginRpcError(
      RPC_ERRORS.permissionDenied,
      "Plugin filesystem path changed after authorization",
    );
  }
  return canonical;
}

function assertSameOpenedFile(openedStats, pathStats) {
  if (
    !openedStats.isFile()
    || !pathStats.isFile()
    || openedStats.dev !== pathStats.dev
    || openedStats.ino !== pathStats.ino
  ) {
    throw new PluginRpcError(
      RPC_ERRORS.permissionDenied,
      "Plugin filesystem target changed after it was opened",
    );
  }
}

function assertSameOpenedDirectory(expectedStats, pathStats) {
  if (
    !expectedStats.isDirectory()
    || !pathStats.isDirectory()
    || expectedStats.dev !== pathStats.dev
    || expectedStats.ino !== pathStats.ino
  ) {
    throw new PluginRpcError(
      RPC_ERRORS.permissionDenied,
      "Plugin filesystem directory changed after authorization",
    );
  }
}

class PluginFilesystemBroker {
  constructor(options = {}) {
    this.quotaManager = options.quotaManager ?? null;
    this.protectedDirectories = options.protectedDirectories ?? [];
    this.protectedReadDirectories = options.protectedReadDirectories ?? [];
    this.protectedFiles = options.protectedFiles ?? [];
    this.fileSystem = options.fileSystem ?? fsp;
    this.openDirectoryHandle = options.openDirectoryHandle ?? null;
    if (this.openDirectoryHandle != null && typeof this.openDirectoryHandle !== "function") {
      throw new TypeError("Secure plugin directory handle adapter must be a function");
    }
  }

  validateRead(params) { return assertReadParams(params); }
  validateWrite(params) {
    const value = assertWriteParams(params);
    return {
      path: value.path,
      encoding: value.encoding,
      data: value.bytes.toString(value.encoding),
      overwrite: value.overwrite,
    };
  }
  validatePath(params) { return assertPathParams(params); }
  validateDirectory(params) {
    if (typeof this.openDirectoryHandle !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unsupported, "Secure plugin directory enumeration is unavailable on this runtime");
    }
    return assertPathParams(params);
  }

  describeReadAuthorization(params, resourceKind = "exact") {
    const value = assertPathParams(params);
    if (resourceKind !== "exact" && resourceKind !== "directory") {
      throw invalidArgument("Plugin filesystem authorization kind is invalid");
    }
    return {
      permission: "filesystem.read",
      resources: [value.path],
      resourceKinds: [resourceKind],
      reason: `Read ${value.path}`,
      operationId: `filesystem.read:${value.path}`,
    };
  }

  describeWriteAuthorization(params) {
    const value = assertSecureWriteMode(assertWriteParams(params));
    return {
      permission: "filesystem.write",
      resources: [value.path],
      resourceKinds: ["exact"],
      reason: `Write ${value.path}`,
      operationId: `filesystem.write:${value.path}`,
    };
  }

  async readFile(params, context) {
    const value = assertReadParams(params);
    await this.#assertReadable(value.path);
    assertAuthorizedPath(context, "filesystem.read", value.path);
    const { canonical, stats } = await resolveExistingPath(value.path, this.fileSystem);
    await this.#assertReadable(canonical);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    if (!stats.isFile()) throw invalidArgument("Plugin filesystem read target is not a file");
    if (stats.size > value.maxBytes) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file is too large");
    }
    const handle = await this.fileSystem.open(canonical, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const [openedStats, pathStats] = await Promise.all([
        handle.stat(),
        this.fileSystem.stat(canonical),
      ]);
      assertSameOpenedFile(openedStats, stats);
      assertSameOpenedFile(openedStats, pathStats);
      if (openedStats.size > value.maxBytes) {
        throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin filesystem file changed or is too large");
      }
      const current = await this.fileSystem.realpath(canonical);
      await this.#assertReadable(current);
      assertAuthorizedPath(context, "filesystem.read", current);
      const bytes = await readBoundedFileHandle(handle, value.maxBytes);
      this.quotaManager?.chargeBytes(context.runtimeId, "filesystem", bytes.byteLength);
      await context.assertActive();
      return { data: bytes.toString(value.encoding) };
    } finally {
      await handle.close();
    }
  }

  async #assertWritable(canonical) {
    const variants = async (entry) => {
      const lexical = path.resolve(entry);
      try { return [lexical, await this.fileSystem.realpath(lexical)]; }
      catch (error) { if (error?.code !== "ENOENT") throw error; return [lexical]; }
    };
    for (const file of this.protectedFiles) {
      if ((await variants(file)).includes(canonical)) {
        throw new PluginRpcError(RPC_ERRORS.permissionDenied, "Host audit storage is protected");
      }
    }
    for (const directory of this.protectedDirectories) {
      for (const parent of await variants(directory)) {
        const relative = path.relative(parent, canonical);
        if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
          throw new PluginRpcError(RPC_ERRORS.permissionDenied, "Host audit storage is protected");
        }
      }
    }
  }

  async #assertReadable(candidate) {
    for (const directory of this.protectedReadDirectories) {
      const variants = [path.resolve(directory)];
      try { variants.push(await this.fileSystem.realpath(directory)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      for (const parent of variants) {
        const relative = path.relative(parent, candidate);
        if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
          throw new PluginRpcError(RPC_ERRORS.permissionDenied, "Private host conversation storage is protected");
        }
      }
    }
  }

  async writeFile(params, context) {
    const value = assertSecureWriteMode(assertWriteParams(params));
    await this.#assertWritable(path.resolve(value.path));
    assertAuthorizedPath(context, "filesystem.write", value.path);
    const { canonical, stats } = await resolveWritePath(value.path, this.fileSystem);
    await this.#assertWritable(canonical);
    assertAuthorizedPath(context, "filesystem.write", canonical);
    this.quotaManager?.chargeBytes(context.runtimeId, "filesystem", value.bytes.byteLength);
    await context.assertActive();
    const flags = fs.constants.O_WRONLY | NOFOLLOW;
    const handle = await this.fileSystem.open(canonical, flags, 0o600);
    try {
      assertAuthorizedPath(context, "filesystem.write", await this.fileSystem.realpath(canonical));
      const [openedStats, pathStats] = await Promise.all([
        handle.stat(),
        this.fileSystem.stat(canonical),
      ]);
      assertSameOpenedFile(openedStats, stats);
      assertSameOpenedFile(openedStats, pathStats);
      await this.#assertWritable(canonical);
      await context.assertActive();
      if (value.overwrite) await handle.truncate(0);
      await handle.writeFile(value.bytes);
      await handle.sync();
      await context.assertActive();
    } finally {
      await handle.close();
    }
    return null;
  }

  async stat(params, context) {
    const value = assertPathParams(params);
    await this.#assertReadable(value.path);
    assertAuthorizedPath(context, "filesystem.read", value.path);
    const { canonical, stats } = await resolveExistingPath(value.path, this.fileSystem);
    await this.#assertReadable(canonical);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    await context.assertActive();
    return {
      kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
      size: Math.min(Number.MAX_SAFE_INTEGER, Number(stats.size)),
      modifiedAt: Math.max(0, Math.trunc(stats.mtimeMs)),
    };
  }

  async readDirectory(params, context) {
    const value = this.validateDirectory(params);
    await this.#assertReadable(value.path);
    assertAuthorizedPath(context, "filesystem.read", value.path);
    const { canonical, stats } = await resolveExistingPath(value.path, this.fileSystem);
    await this.#assertReadable(canonical);
    assertAuthorizedPath(context, "filesystem.read", canonical);
    if (!stats.isDirectory()) throw invalidArgument("Plugin filesystem directory target is not a directory");
    const directory = await this.openDirectoryHandle(canonical, { signal: context.signal });
    if (
      !directory
      || typeof directory.stat !== "function"
      || typeof directory.read !== "function"
      || typeof directory.close !== "function"
    ) throw new TypeError("Secure plugin directory handle adapter returned an invalid handle");
    try {
      assertSameOpenedDirectory(stats, await directory.stat());
      const entries = [];
      for (;;) {
        const entry = await directory.read();
        if (entry === null) break;
        entries.push(entry);
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
          throw new PluginRpcError(
            RPC_ERRORS.resourceExhausted,
            "Plugin filesystem directory has too many entries",
          );
        }
      }
      assertSameOpenedDirectory(stats, await directory.stat());
      assertSameOpenedDirectory(stats, await this.fileSystem.stat(canonical));
      await context.assertActive();
      return {
        entries: entries
          .map((entry) => ({ name: entry.name, kind: entryKind(entry) }))
          .sort((left, right) => left.name.localeCompare(right.name, "en")),
      };
    } finally {
      await directory.close();
    }
  }
}

module.exports = {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILESYSTEM_BYTES,
  PluginFilesystemBroker,
  assertAbsolutePath,
  assertAuthorizedPath,
  assertSameOpenedFile,
  assertSameOpenedDirectory,
  assertPathParams,
  assertReadParams,
  assertSecureWriteMode,
  assertWriteParams,
  resolveExistingPath,
  resolveWritePath,
  readBoundedFileHandle,
};
