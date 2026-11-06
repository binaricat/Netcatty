"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { getTempFilePath } = require("../bridges/tempDirBridge.cjs");
const { parsePluginGitHubRepository } = require("../../domain/pluginGitHubRepository.cjs");
const { assertBrowserOnlyPlugin } = require("../../domain/pluginRuntimePolicy.cjs");
const { githubSource } = require("./sourceIdentity.cjs");

const JSON_LIMIT = 2 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60_000;
const DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function assertGitHubUrl(value, api = false) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || /[\u0000-\u0020\u007f\\]/u.test(value)
    || !(api ? url.hostname === "api.github.com" : DOWNLOAD_HOSTS.has(url.hostname))) {
    throw new Error("GitHub download redirected outside approved HTTPS hosts");
  }
  return url.href;
}

async function fetchGitHubBytes(url, { limit, api = false, fetchImpl = fetch, signal = AbortSignal.timeout(30_000) }) {
  for (let redirects = 0; ; redirects++) {
    assertGitHubUrl(url, api);
    let response;
    try {
      response = await fetchImpl(url, { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal,
        headers: { Accept: api ? "application/vnd.github+json" : "application/octet-stream", "User-Agent": "Netcatty-Plugin-Installer" } });
    } catch (cause) { throw new Error(signal.aborted ? "GitHub download timed out" : "Cannot reach GitHub. Check your network connection and try again", { cause }); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (api) throw new Error("GitHub repository moved. Enter its current repository URL");
      if (redirects >= 3) throw new Error("Too many GitHub download redirects");
      const location = response.headers.get("location");
      if (!location) throw new Error("GitHub download redirect has no destination");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) throw new Error("GitHub API rate limit reached. Try again later");
      if (response.status === 404) {
        const error = new Error("GitHub repository or asset not found. Only accessible public repositories are supported; private repositories require local import");
        error.status = 404;
        throw error;
      }
      if ([401, 403].includes(response.status)) throw new Error("GitHub access denied. Private repositories and login are not supported");
      throw new Error(`GitHub download failed (HTTP ${response.status})`);
    }
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("GitHub download exceeds size limit"); }
    if (/text\/html|(?:application|text)\/(?:[^;]*\+)?xml/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel(); throw new Error("GitHub returned HTML/XML instead of a plugin package or release metadata");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("GitHub download has no body");
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("GitHub download exceeds size limit");
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } catch (cause) {
      if (signal.aborted) throw new Error("GitHub download timed out", { cause });
      throw cause;
    } finally { await reader.cancel(); }
  }
}

class GitHubInstallService {
  constructor(options) {
    this.manager = options.manager;
    // Injection is main-process/test-only. Neither renderer IPC nor plugin RPC can set a URL or transport.
    this.fetch = options.fetch ?? fetch;
    this.tempPath = options.getTempFilePath ?? getTempFilePath;
    this.previews = new Map();
    this.active = new Set();
  }

  async discard(owner, token) {
    const pending = this.previews.get(owner);
    if (!pending || (token !== undefined && pending.preview.token !== token)) return;
    this.previews.delete(owner);
    clearTimeout(pending.timer);
    await fs.rm(pending.directory, { recursive: true, force: true });
  }

  async prepare(owner, input) {
    const repository = parsePluginGitHubRepository(input);
    if (this.active.has(owner) || this.active.size + this.previews.size >= 8) throw new Error("A GitHub plugin operation is already active. Close the preview and try again");
    this.active.add(owner);
    let directory;
    try {
      await this.discard(owner);
      const signal = AbortSignal.timeout(90_000);
      const json = async (url) => {
        const bytes = await fetchGitHubBytes(url, { limit: JSON_LIMIT, api: true, fetchImpl: this.fetch, signal });
        try {
          const result = JSON.parse(bytes.toString("utf8"));
          if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid metadata shape");
          return result;
        } catch { throw new Error("GitHub returned invalid release metadata (expected JSON object)"); }
      };
      const apiRoot = `https://api.github.com/repos/${repository.repository}`;
      const repo = await json(apiRoot);
      if (typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== repository.repository || repo.private !== false) throw new Error("GitHub did not return the selected public repository");
      let release;
      try { release = await json(`${apiRoot}/releases/latest`); }
      catch (error) {
        if (error.status === 404) throw new Error("This repository has no published stable release. Ask the author to publish a release with a .ncpkg asset, or import a built package locally");
        throw error;
      }
      if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !release.tag_name || release.tag_name.length > 256
        || /[\u0000-\u001f\u007f]/u.test(release.tag_name)) throw new Error("Publish a stable GitHub release with a tag and a .ncpkg asset first");
      const assets = Array.isArray(release.assets) ? release.assets.filter((asset) => typeof asset.name === "string" && /\.ncpkg$/iu.test(asset.name)) : [];
      if (assets.length !== 1) throw new Error(assets.length ? "Release contains multiple .ncpkg assets. Import the intended package locally" : "Release has no .ncpkg asset. Ask the author to build and attach one; source repositories cannot be built by Netcatty");
      const asset = assets[0];
      if (!/^[a-z0-9][a-z0-9._-]*\.ncpkg$/iu.test(asset.name) || asset.name.length > 200
        || !Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== "uploaded") throw new Error("Invalid GitHub plugin artifact name or identity");
      let download;
      try { download = new URL(asset.browser_download_url); }
      catch { throw new Error("GitHub release asset has no valid download URL"); }
      const expectedPath = `/${repository.repository}/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`;
      const repositoryPath = `/${repository.repository}/`;
      if (download.origin !== "https://github.com" || !download.pathname.toLowerCase().startsWith(repositoryPath)
        || download.pathname.slice(repositoryPath.length) !== expectedPath.slice(repositoryPath.length)
        || download.search || download.hash || download.username || download.password) throw new Error("GitHub asset does not belong to the selected repository and release");
      let commit;
      try { commit = await json(`${apiRoot}/commits/${encodeURIComponent(release.tag_name)}`); }
      catch (error) {
        if (error.status === 404) throw new Error("The release tag has no accessible commit. Ask the author to repair the release tag");
        throw error;
      }
      const source = githubSource(repository.origin, { tag: release.tag_name, commit: commit.sha, assetId: asset.id });
      const cli = await import("@netcatty/plugin-cli");
      if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > cli.PACKAGE_LIMITS.archiveBytes) throw new Error("GitHub package size is invalid or exceeds size limit");
      const bytes = await fetchGitHubBytes(download.href, { limit: cli.PACKAGE_LIMITS.archiveBytes, fetchImpl: this.fetch, signal });
      if (bytes.length !== asset.size) throw new Error("GitHub package size mismatch");
      if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error("Expected a .ncpkg ZIP package; GitHub returned another file (possibly HTML/XML)");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (asset.digest != null && asset.digest !== `sha256:${sha256}`) throw new Error("GitHub package SHA-256 mismatch");
      directory = await fs.mkdtemp(this.tempPath("plugin-github-"));
      const archive = path.join(directory, "package.ncpkg");
      await fs.writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
      const { manifest } = await cli.validatePluginPackage(archive);
      const store = this.manager.packageStore;
      if (!store.allowAdvancedPlugins) assertBrowserOnlyPlugin(manifest);
      const compatible = cli.checkPluginCompatibility(manifest, { netcattyVersion: store.netcattyVersion, apiVersion: store.apiVersion, features: store.supportedFeatures });
      if (!compatible.compatible) throw new Error(`Plugin is incompatible: ${compatible.errors.join("; ")}`);
      this.manager.database.assertInstallSource(manifest.id, source);
      if (owner?.isDestroyed?.()) throw new Error("Plugin management window closed");
      const preview = { token: randomUUID(), source, manifest, archiveSha256: sha256, assetName: asset.name, size: bytes.length };
      const timer = setTimeout(() => { void this.discard(owner, preview.token).catch(() => {}); }, PREVIEW_TTL_MS);
      timer.unref?.();
      this.previews.set(owner, { preview, directory, archive, timer });
      directory = null;
      return structuredClone(preview);
    } finally {
      this.active.delete(owner);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async install(owner, token) {
    const pending = this.previews.get(owner);
    if (!pending || pending.preview.token !== token) throw new Error("GitHub package preview expired. Download and review it again");
    if (this.active.has(owner)) throw new Error("A GitHub plugin operation is already active");
    this.active.add(owner);
    clearTimeout(pending.timer);
    try {
      return await this.manager.install(pending.archive, { enable: false, source: pending.preview.source,
        expectedPackage: { sha256: pending.preview.archiveSha256, manifest: pending.preview.manifest } });
    } finally { this.active.delete(owner); await this.discard(owner, token); }
  }
}

module.exports = { GitHubInstallService, fetchGitHubBytes, assertGitHubUrl };
