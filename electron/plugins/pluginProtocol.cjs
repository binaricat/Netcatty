"use strict";

const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");
const { normalizePluginModuleResources } = require("./moduleResources.cjs");
const { isPathInside } = require("./paths.cjs");

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
]);

function createRuntimeToken() {
  return randomBytes(24).toString("base64url").toLowerCase();
}

function decodeRequestPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new Error("Malformed plugin URL encoding"); }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) {
    throw new Error("Unsafe plugin URL path");
  }
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Unsafe plugin URL path");
  }
  return segments;
}

async function readContainedFile(root, segments, maxBytes = Infinity) {
  const candidate = path.resolve(root, ...segments);
  if (!isPathInside(root, candidate)) throw new Error("Plugin resource escapes its root");
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (!isPathInside(realRoot, realCandidate)) throw new Error("Plugin resource follows a symlink outside its root");
  const stats = await fs.lstat(realCandidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Plugin resource is not a regular file");
  if (stats.size > maxBytes) throw new Error('Plugin resource exceeds size limit');
  const body = await fs.readFile(realCandidate);
  if (body.length > maxBytes) throw new Error('Plugin resource exceeds size limit');
  return { body, filePath: realCandidate };
}

function htmlForRuntime(token, moduleResources) {
  const imports = Object.fromEntries(moduleResources.map((resource) => [
    resource.specifier,
    `${PLUGIN_PROTOCOL_SCHEME}://${token}/__host/modules/${resource.route}/${resource.entry}`,
  ]));
  const runtime = `${PLUGIN_PROTOCOL_SCHEME}://${token}/__host/runtime/browserRuntime.mjs`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Netcatty plugin runtime</title>
<script type="importmap" nonce="${token}">${JSON.stringify({ imports })}</script></head><body><script type="module" src="${runtime}"></script></body></html>`;
}

class PluginProtocol {
  constructor(options) {
    this.runtimeDirectory = options.runtimeDirectory;
    this.sdkDirectory = options.sdkDirectory;
    this.contractDirectory = options.contractDirectory;
    this.moduleResources = options.moduleResources
      ? normalizePluginModuleResources(options.moduleResources)
      : normalizePluginModuleResources([
          { specifier: "@netcatty/plugin-sdk", directory: options.sdkDirectory },
          { specifier: "@netcatty/plugin-contract", directory: options.contractDirectory },
        ]);
    this.moduleResourcesByRoute = new Map(this.moduleResources.map((resource) => [resource.route, resource]));
    this.registrations = new Map();
    this.sessions = new WeakSet();
  }

  registerSession(session) {
    if (this.sessions.has(session)) {
      throw new Error("Plugin protocol is already registered for this session");
    }
    session.protocol.handle(PLUGIN_PROTOCOL_SCHEME, (request) => this.#handle(request));
    this.sessions.add(session);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.sessions.delete(session);
        session.protocol.unhandle(PLUGIN_PROTOCOL_SCHEME);
      },
    };
  }

  registerRuntime(options) {
    const token = createRuntimeToken();
    this.registrations.set(token, {
      token,
      pluginId: options.pluginId,
      packageRoot: options.packageRoot,
      config: options.config,
      kind: "runtime",
    });
    return {
      token,
      url: `${PLUGIN_PROTOCOL_SCHEME}://${token}/index.html`,
      dispose: () => this.registrations.delete(token),
    };
  }

  async #handle(request) {
    const headers = {
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-DNS-Prefetch-Control": "off",
      "X-Content-Type-Options": "nosniff",
    };
    const respond = (body, status, contentType = "text/plain; charset=utf-8", extraHeaders = {}) => (
      new Response(body, { status, headers: { ...headers, "Content-Type": contentType, ...extraHeaders } })
    );
    try {
      if (request.method !== "GET") return respond("Method Not Allowed", 405);
      const url = new URL(request.url);
      if (url.username || url.password || url.port || url.search || url.hash) return respond("Bad Request", 400);
      const registration = this.registrations.get(url.hostname);
      if (!registration) return respond("Not Found", 404);
      const segments = decodeRequestPath(url.pathname);
      const csp = `default-src 'none'; script-src 'self' ${PLUGIN_PROTOCOL_SCHEME}: 'nonce-${registration.token}'; connect-src 'self' ${PLUGIN_PROTOCOL_SCHEME}:; img-src 'self' ${PLUGIN_PROTOCOL_SCHEME}:; style-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'`;
      if (segments.length === 1 && segments[0] === "index.html") {
        return respond(htmlForRuntime(registration.token, this.moduleResources), 200, "text/html; charset=utf-8", {
          "Content-Security-Policy": csp,
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(), fullscreen=(), clipboard-read=(), clipboard-write=()",
        });
      }
      if (segments.join("/") === "__host/runtime/config.json") {
        return respond(JSON.stringify(registration.config), 200, "application/json; charset=utf-8");
      }
      let root;
      let fileSegments;
      let packageResource = false;
      if (segments[0] === "package") {
        packageResource = true;
        root = registration.packageRoot;
        fileSegments = segments.slice(1);
      } else if (segments[0] === "__host" && segments[1] === "runtime") {
        root = this.runtimeDirectory;
        fileSegments = segments.slice(2);
      } else if (segments[0] === "__host" && segments[1] === "modules") {
        const resource = this.moduleResourcesByRoute.get(segments[2]);
        if (!resource) return respond("Not Found", 404);
        root = resource.directory;
        fileSegments = segments.slice(3);
      } else return respond("Not Found", 404);
      if (!fileSegments.length || (!packageResource && fileSegments.some((segment) => segment.startsWith(".")))) {
        return respond("Not Found", 404);
      }
      const file = await readContainedFile(root, fileSegments);
      const contentType = CONTENT_TYPES.get(path.extname(file.filePath).toLowerCase())
        ?? "application/octet-stream";
      return respond(file.body, 200, contentType);
    } catch {
      return respond("Not Found", 404);
    }
  }
}

module.exports = {
  PluginProtocol,
  createRuntimeToken,
  decodeRequestPath,
  readContainedFile,
};
