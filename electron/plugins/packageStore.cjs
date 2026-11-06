"use strict";

const { LOCAL_SOURCE, assertSource } = require("./sourceIdentity.cjs");

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { constants } = fs;
const {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} = require("node:fs/promises");
const path = require("node:path");

const {
  assertPluginStorageSegment,
  isPathInside,
  resolveInstalledVersionDirectory,
} = require("./paths.cjs");

const { assertBrowserOnlyPlugin } = require("../../domain/pluginRuntimePolicy.cjs");
const { assertCatalogManifest } = require("./catalogPolicy.cjs");

const INSTALL_METADATA_FILE = "install.json";
const ARCHIVE_SNAPSHOT_FILE = "package.ncpkg";
const PACKAGE_DIRECTORY = "package";
const REMOVAL_METADATA_FILE = "remove.json";
const REMOVED_PLUGIN_DIRECTORY = "plugin";

async function loadPluginCli() {
  return import("@netcatty/plugin-cli");
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

async function writeDurableMetadata(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await syncDirectoryTree(path.join(directory, entry.name));
  }
  await syncDirectory(directory);
}

async function copyImmutableArchive(sourcePath, destinationPath, maxBytes) {
  const sourcePathStats = await lstat(sourcePath);
  if (!sourcePathStats.isFile() || sourcePathStats.isSymbolicLink()) {
    throw new Error("Plugin package source must be a regular non-symbolic file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  let destination;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error("Plugin package source must be a regular file");
    if (before.size > maxBytes) throw new Error(`Plugin archive exceeds ${maxBytes} bytes`);
    destination = await open(destinationPath, "wx", 0o600);
    const sha256 = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written);
        if (result.bytesWritten === 0) throw new Error("Unable to stage the complete plugin package");
        written += result.bytesWritten;
      }
    }
    const after = await source.stat();
    if (
      position !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || (before.ino && after.ino && before.ino !== after.ino)
    ) {
      throw new Error("Plugin package source changed while it was staged");
    }
    await destination.sync();
    return { bytes: position, sha256: sha256.digest("hex") };
  } finally {
    await destination?.close();
    await source.close();
  }
}

function validateInstallMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plugin install metadata");
  }
  const pluginId = assertPluginStorageSegment(value.pluginId, "ID");
  const version = assertPluginStorageSegment(value.version, "version");
  if (!/^[a-f0-9]{64}$/u.test(value.archiveSha256)) {
    throw new Error("Invalid plugin install archive hash");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.contentSha256)) {
    throw new Error("Invalid plugin install content hash");
  }
  return {
    pluginId,
    version,
    archiveSha256: value.archiveSha256,
    contentSha256: value.contentSha256,
    source: assertSource(value.source ?? LOCAL_SOURCE),
  };
}

function validateRemovalMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plugin removal metadata");
  }
  return { pluginId: assertPluginStorageSegment(value.pluginId, "ID") };
}

class PackageStore {
  constructor(options) {
    this.allowAdvancedPlugins = options.allowAdvancedPlugins !== false;
    this.paths = options.paths;
    this.database = options.database;
    this.netcattyVersion = options.netcattyVersion;
    this.apiVersion = options.apiVersion;
    this.supportedFeatures = [...(options.supportedFeatures ?? [])];
    this.logger = options.logger ?? console;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
    this.verifiedArchives = new Map();
  }

  async initialize() {
    await Promise.all(Object.values(this.paths)
      .filter((value) => typeof value === "string" && value !== this.paths.database)
      .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    await this.recover();
    // Reconcile every installed manifest before lazy contributions are exposed.
    // An application/API upgrade must not leave incompatible providers enabled.
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled) continue;
      await this.assertCompatible(plugin).catch((error) => {
        if (!["PLUGIN_INCOMPATIBLE", "PLUGIN_UNSUPPORTED_RUNTIME"].includes(error.code)) throw error;
      });
    }
  }

  async assertCompatible(plugin) {
    const pluginCli = await loadPluginCli();
    const result = pluginCli.checkPluginCompatibility(plugin.manifest, {
      netcattyVersion: this.netcattyVersion,
      apiVersion: this.apiVersion,
      features: this.supportedFeatures,
    });
    let error;
    if (!this.allowAdvancedPlugins) {
      try { assertBrowserOnlyPlugin(plugin.manifest); } catch (cause) { error = cause; }
    }
    if (!error && result.compatible) return result;
    if (!error) {
      error = new Error(`Plugin is incompatible: ${result.errors.join("; ")}`);
      error.code = "PLUGIN_INCOMPATIBLE";
    }
    const current = this.database.getActivePlugin(plugin.id);
    if (current?.activeVersion === plugin.activeVersion) {
      this.database.setEnabled(plugin.id, false);
      this.database.setRuntimeState(plugin.id, "error", {
        pluginVersion: plugin.activeVersion,
        error: error.message,
      });
    }
    throw error;
  }

  async install(archivePath, options = {}) {
    if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) {
      throw new TypeError("Plugin package path must be absolute");
    }
    if (path.extname(archivePath).toLowerCase() !== ".ncpkg") {
      throw new Error("Plugin packages must use the .ncpkg extension");
    }
    const pluginCli = await loadPluginCli();
    const stagingName = `install-${randomUUID()}`;
    const stagingDirectory = path.join(this.paths.staging, stagingName);
    const archiveSnapshot = path.join(stagingDirectory, ARCHIVE_SNAPSHOT_FILE);
    const extractedDirectory = path.join(stagingDirectory, PACKAGE_DIRECTORY);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      const snapshot = await copyImmutableArchive(
        archivePath,
        archiveSnapshot,
        pluginCli.PACKAGE_LIMITS.archiveBytes,
      );
      const validation = await pluginCli.extractPluginPackage(archiveSnapshot, extractedDirectory);
      await syncDirectoryTree(extractedDirectory);
      const manifest = validation.manifest;
      if (!this.allowAdvancedPlugins) assertBrowserOnlyPlugin(manifest);
      const compatibility = pluginCli.checkPluginCompatibility(manifest, {
        netcattyVersion: this.netcattyVersion,
        apiVersion: this.apiVersion,
        features: this.supportedFeatures,
      });
      if (!compatibility.compatible) {
        throw new Error(`Plugin is incompatible: ${compatibility.errors.join("; ")}`);
      }
      const pluginId = assertPluginStorageSegment(manifest.id, "ID");
      const version = assertPluginStorageSegment(manifest.version, "version");
      const targetDirectory = resolveInstalledVersionDirectory(this.paths, pluginId, version);
      const source = this.database.assertInstallSource(pluginId, options.source ?? LOCAL_SOURCE);
      const previousPlugin = this.database.getActivePlugin(pluginId);
      if (options.catalog) {
        if (snapshot.sha256 !== options.catalog.artifact.sha256) throw new Error("Catalog package SHA-256 mismatch");
        assertCatalogManifest(manifest, options.catalog);
        // Detail-page permissions and engine ranges must describe these exact bytes.
        const { isDeepStrictEqual } = require("node:util");
        if (!isDeepStrictEqual(manifest, options.catalog.manifest)) throw new Error("Catalog manifest does not match package");
      }
      const enableAfterActivation = options.enable === false
        ? false
        : options.enable === true || previousPlugin?.enabled === true;
      let activationPrepared = false;
      const prepareActivation = async (reason) => {
        if (activationPrepared) return;
        if (typeof options.beforeActivate === "function") {
          await options.beforeActivate(Object.freeze({
            pluginId,
            version,
            previousPlugin,
            reason,
          }));
        }
        activationPrepared = true;
      };
      const existing = this.database.getVersion(pluginId, version);
      if (existing) {
        if (existing.archiveSha256 !== snapshot.sha256) {
          throw new Error(`Plugin ${pluginId}@${version} is already installed with different contents`);
        }
        let existingValidation;
        try {
          existingValidation = await this.verifyInstalledVersion(existing, { refreshArchive: true });
        } catch {
          if (previousPlugin?.activeVersion === version) await prepareActivation("replace-active-files");
          await rm(targetDirectory, { recursive: true, force: true });
        }
        if (existingValidation) {
          if (previousPlugin?.activeVersion !== version || options.enable === false) await prepareActivation("switch-active-version");
          const existingPackage = path.join(targetDirectory, PACKAGE_DIRECTORY);
          this.database.installVersion({
            source,
            pluginId,
            version,
            manifest: existingValidation.manifest,
            archiveSha256: existing.archiveSha256,
            packageRelativePath: path.relative(this.paths.packages, existingPackage),
          }, { enable: enableAfterActivation, forceDisabled: options.enable === false });
          return this.database.getActivePlugin(pluginId);
        }
      }
      try {
        await stat(targetDirectory);
        throw new Error(`Plugin ${pluginId}@${version} has an uncommitted installed directory`);
      } catch (error) {
        if (!(error && error.code === "ENOENT")) throw error;
      }
      const metadata = {
        source,
        pluginId,
        version,
        archiveSha256: snapshot.sha256,
        contentSha256: validation.contentSha256,
      };
      await writeDurableMetadata(path.join(stagingDirectory, INSTALL_METADATA_FILE), metadata);
      await this.syncDirectory(stagingDirectory);
      await mkdir(path.dirname(targetDirectory), { recursive: true, mode: 0o700 });
      if (previousPlugin?.activeVersion !== version || options.enable === false) await prepareActivation("switch-active-version");
      await rename(stagingDirectory, targetDirectory);
      await this.syncDirectory(path.dirname(targetDirectory));
      const packageRelativePath = path.relative(
        this.paths.packages,
        path.join(targetDirectory, PACKAGE_DIRECTORY),
      );
      try {
        this.database.installVersion({
          source,
          pluginId,
          version,
          manifest,
          archiveSha256: snapshot.sha256,
          packageRelativePath,
        }, { enable: enableAfterActivation, forceDisabled: options.enable === false });
      } catch (error) {
        this.verifiedArchives.delete(this.#versionKey(pluginId, version));
        await rm(targetDirectory, { recursive: true, force: true });
        await this.syncDirectory(path.dirname(targetDirectory));
        throw error;
      }
      this.verifiedArchives.set(this.#versionKey(pluginId, version), Object.freeze({
        archiveSha256: snapshot.sha256,
        contentSha256: validation.contentSha256,
        manifest,
      }));
      return this.database.getActivePlugin(pluginId);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async recover() {
    this.verifiedArchives.clear();
    await mkdir(this.paths.staging, { recursive: true, mode: 0o700 });
    const stagedEntries = await readdir(this.paths.staging, { withFileTypes: true });
    for (const entry of stagedEntries) {
      const stagedPath = path.join(this.paths.staging, entry.name);
      if (!entry.isDirectory() || !entry.name.startsWith("remove-")) {
        await rm(stagedPath, { recursive: true, force: true });
        continue;
      }
      const removedPluginPath = path.join(stagedPath, REMOVED_PLUGIN_DIRECTORY);
      let hasMovedPlugin = false;
      try {
        await lstat(removedPluginPath);
        hasMovedPlugin = true;
      } catch (error) {
        if (!(error && error.code === "ENOENT")) throw error;
      }
      // A crash can happen after remove-* is created but before remove.json is
      // durably written or before the installed package is moved. With no
      // moved package there is nothing to restore, so discard the debris even
      // when the metadata is missing or partial. If plugin/ exists, metadata
      // remains mandatory so recovery never deletes an unidentified package.
      if (!hasMovedPlugin) {
        await rm(stagedPath, { recursive: true, force: true });
        continue;
      }
      const metadata = validateRemovalMetadata(JSON.parse(await readFile(
        path.join(stagedPath, REMOVAL_METADATA_FILE),
        "utf8",
      )));
      const installedPluginPath = path.join(this.paths.packages, metadata.pluginId);
      const databasePlugin = this.database.getActivePlugin(metadata.pluginId);
      if (databasePlugin) {
        let installedExists = false;
        try {
          const installedStats = await lstat(installedPluginPath);
          installedExists = installedStats.isDirectory() && !installedStats.isSymbolicLink();
        } catch (error) {
          if (!(error && error.code === "ENOENT")) throw error;
        }
        if (!installedExists) {
          const removedStats = await lstat(removedPluginPath);
          if (!removedStats.isDirectory() || removedStats.isSymbolicLink()) {
            throw new Error(`Pending plugin removal is incomplete: ${metadata.pluginId}`);
          }
          await rename(removedPluginPath, installedPluginPath);
          await this.syncDirectory(this.paths.packages);
        }
      }
      await rm(stagedPath, { recursive: true, force: true });
    }
    const pluginDirectories = await readdir(this.paths.packages, { withFileTypes: true });
    for (const pluginEntry of pluginDirectories) {
      if (!pluginEntry.isDirectory()) continue;
      const pluginDirectory = path.join(this.paths.packages, pluginEntry.name);
      const versions = await readdir(pluginDirectory, { withFileTypes: true });
      for (const versionEntry of versions) {
        if (!versionEntry.isDirectory()) continue;
        const versionDirectory = path.join(pluginDirectory, versionEntry.name);
        const committedVersion = this.database.getVersion(pluginEntry.name, versionEntry.name);
        try {
          const metadata = validateInstallMetadata(JSON.parse(await readFile(
            path.join(versionDirectory, INSTALL_METADATA_FILE),
            "utf8",
          )));
          if (metadata.pluginId !== pluginEntry.name || metadata.version !== versionEntry.name) {
            throw new Error("Plugin install metadata does not match its directory");
          }
          this.database.assertInstallSource(metadata.pluginId, metadata.source);
          if (committedVersion && committedVersion.archiveSha256 !== metadata.archiveSha256) {
            throw new Error("Plugin install archive hash does not match its database record");
          }
          const validation = await this.verifyInstalledVersion(committedVersion ?? {
            pluginId: metadata.pluginId,
            version: metadata.version,
            archiveSha256: metadata.archiveSha256,
            packageRelativePath: path.relative(
              this.paths.packages,
              path.join(versionDirectory, PACKAGE_DIRECTORY),
            ),
          });
          if (!committedVersion) {
            const packageDirectory = path.join(versionDirectory, PACKAGE_DIRECTORY);
            this.database.installVersion({
              source: metadata.source,
              pluginId: metadata.pluginId,
              version: metadata.version,
              manifest: validation.manifest,
              archiveSha256: metadata.archiveSha256,
              packageRelativePath: path.relative(this.paths.packages, packageDirectory),
            }, { forceDisabled: true });
          }
        } catch (error) {
          this.verifiedArchives.delete(this.#versionKey(pluginEntry.name, versionEntry.name));
          this.logger.warn?.(committedVersion
            ? "[Plugins] Retaining invalid committed package fail-closed"
            : "[Plugins] Removing invalid uncommitted package", {
            directory: versionDirectory,
            error: error?.message ?? String(error),
          });
          if (committedVersion) {
            const activePlugin = this.database.getActivePlugin(committedVersion.pluginId);
            if (activePlugin?.activeVersion === committedVersion.version) {
              this.database.setEnabled(committedVersion.pluginId, false);
              this.database.setRuntimeState(committedVersion.pluginId, "error", {
                pluginVersion: committedVersion.version,
                error: `Installed package integrity check failed: ${error?.message ?? String(error)}`,
              });
            }
          } else {
            await rm(versionDirectory, { recursive: true, force: true });
          }
        }
      }
    }
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.packageRelativePath) continue;
      try {
        await this.preparePackageRoot(plugin);
      } catch (error) {
        this.database.setEnabled(plugin.id, false);
        this.database.setRuntimeState(plugin.id, "error", {
          error: `Installed package integrity check failed: ${error?.message ?? String(error)}`,
        });
      }
    }
  }

  resolvePackageRoot(plugin) {
    const relativePath = plugin?.packageRelativePath;
    if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
      throw new Error("Plugin package path is invalid");
    }
    const packageRoot = path.resolve(this.paths.packages, relativePath);
    if (!isPathInside(this.paths.packages, packageRoot)) {
      throw new Error("Plugin package path escapes the package store");
    }
    return packageRoot;
  }

  #versionKey(pluginId, version) {
    return `${pluginId}\0${version}`;
  }

  #recordIdentity(record) {
    const pluginId = assertPluginStorageSegment(record?.pluginId ?? record?.id, "ID");
    const version = assertPluginStorageSegment(record?.version ?? record?.activeVersion, "version");
    if (!/^[a-f0-9]{64}$/u.test(record?.archiveSha256)) {
      throw new Error("Plugin database archive hash is invalid");
    }
    return { pluginId, version, archiveSha256: record.archiveSha256 };
  }

  async #loadVerifiedArchive(record, options = {}) {
    const identity = this.#recordIdentity(record);
    const key = this.#versionKey(identity.pluginId, identity.version);
    const cached = this.verifiedArchives.get(key);
    if (options.refresh !== true && cached?.archiveSha256 === identity.archiveSha256) return cached;

    const pluginCli = await loadPluginCli();
    const versionDirectory = resolveInstalledVersionDirectory(
      this.paths,
      identity.pluginId,
      identity.version,
    );
    const metadata = validateInstallMetadata(JSON.parse(await readFile(
      path.join(versionDirectory, INSTALL_METADATA_FILE),
      "utf8",
    )));
    if (
      metadata.pluginId !== identity.pluginId
      || metadata.version !== identity.version
      || metadata.archiveSha256 !== identity.archiveSha256
    ) {
      throw new Error("Plugin install metadata does not match its database record");
    }

    const verificationDirectory = path.join(this.paths.staging, `verify-${randomUUID()}`);
    const verificationSnapshot = path.join(verificationDirectory, ARCHIVE_SNAPSHOT_FILE);
    await mkdir(verificationDirectory, { recursive: false, mode: 0o700 });
    try {
      const snapshot = await copyImmutableArchive(
        path.join(versionDirectory, ARCHIVE_SNAPSHOT_FILE),
        verificationSnapshot,
        pluginCli.PACKAGE_LIMITS.archiveBytes,
      );
      if (snapshot.sha256 !== identity.archiveSha256) {
        throw new Error("Retained plugin archive hash does not match its database record");
      }
      const validation = await pluginCli.validatePluginPackage(verificationSnapshot);
      if (validation.contentSha256 !== metadata.contentSha256) {
        throw new Error("Retained plugin archive content does not match install metadata");
      }
      if (
        validation.manifest.id !== identity.pluginId
        || validation.manifest.version !== identity.version
      ) {
        throw new Error("Retained plugin archive identity does not match its database record");
      }
      const verified = Object.freeze({
        archiveSha256: identity.archiveSha256,
        contentSha256: validation.contentSha256,
        manifest: validation.manifest,
      });
      this.verifiedArchives.set(key, verified);
      return verified;
    } finally {
      await rm(verificationDirectory, { recursive: true, force: true });
    }
  }

  async verifyInstalledVersion(record, options = {}) {
    const identity = this.#recordIdentity(record);
    const expected = await this.#loadVerifiedArchive(record, {
      refresh: options.refreshArchive === true,
    });
    const packageRoot = this.resolvePackageRoot({
      packageRelativePath: record.packageRelativePath,
    });
    const packageStats = await stat(packageRoot);
    if (!packageStats.isDirectory()) throw new Error("Plugin package root is not a directory");
    const pluginCli = await loadPluginCli();
    const validation = await pluginCli.validatePluginDirectory(packageRoot, {
      allowIgnoredRootEntries: false,
    });
    if (
      validation.manifest.id !== identity.pluginId
      || validation.manifest.version !== identity.version
    ) {
      throw new Error("Installed plugin identity does not match its database record");
    }
    if (validation.contentSha256 !== expected.contentSha256) {
      throw new Error("Installed plugin files do not match the retained package archive");
    }
    if (record.manifest && JSON.stringify(record.manifest) !== JSON.stringify(expected.manifest)) {
      throw new Error("Plugin database manifest does not match the retained package archive");
    }
    return validation;
  }

  async preparePackageRoot(plugin) {
    try {
      await this.verifyInstalledVersion(plugin);
      return this.resolvePackageRoot(plugin);
    } catch (error) {
      const identity = this.#recordIdentity(plugin);
      const active = this.database.getActivePlugin(identity.pluginId);
      if (active?.activeVersion === identity.version) {
        this.database.setEnabled(identity.pluginId, false);
        this.database.setRuntimeState(identity.pluginId, "error", {
          pluginVersion: identity.version,
          error: `Installed package integrity check failed: ${error?.message ?? String(error)}`,
        });
      }
      throw error;
    }
  }

  async clearUninstalledPrivateFiles(pluginId) {
    assertPluginStorageSegment(pluginId, "ID");
    if (this.database.getActivePlugin(pluginId)) throw new Error("Plugin is still installed");
    await rm(path.join(this.paths.data, pluginId), { recursive: true, force: true });
  }

  async uninstall(pluginId) {
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin) return false;
    const pluginDirectory = path.join(
      this.paths.packages,
      assertPluginStorageSegment(pluginId, "ID"),
    );
    const removalDirectory = path.join(this.paths.staging, `remove-${randomUUID()}`);
    const removedPluginPath = path.join(removalDirectory, REMOVED_PLUGIN_DIRECTORY);
    await mkdir(removalDirectory, { recursive: false, mode: 0o700 });
    await writeDurableMetadata(
      path.join(removalDirectory, REMOVAL_METADATA_FILE),
      { pluginId },
    );
    await syncDirectory(removalDirectory);
    let moved = false;
    try {
      await rename(pluginDirectory, removedPluginPath);
      moved = true;
      await this.syncDirectory(removalDirectory);
      await this.syncDirectory(this.paths.packages);
    } catch (error) {
      if (!(error && error.code === "ENOENT")) throw error;
    }
    try {
      this.database.removePlugin(pluginId);
    } catch (error) {
      let restored = !moved;
      if (moved) {
        try {
          await rename(removedPluginPath, pluginDirectory);
          await this.syncDirectory(this.paths.packages);
          restored = true;
        } catch {}
      }
      if (restored) await rm(removalDirectory, { recursive: true, force: true });
      throw error;
    }
    await rm(removalDirectory, { recursive: true, force: true });
    for (const key of this.verifiedArchives.keys()) {
      if (key.startsWith(`${pluginId}\0`)) this.verifiedArchives.delete(key);
    }
    return true;
  }
}

module.exports = {
  ARCHIVE_SNAPSHOT_FILE,
  INSTALL_METADATA_FILE,
  PACKAGE_DIRECTORY,
  REMOVAL_METADATA_FILE,
  REMOVED_PLUGIN_DIRECTORY,
  PackageStore,
  copyImmutableArchive,
  validateInstallMetadata,
  validateRemovalMetadata,
};
