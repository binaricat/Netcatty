"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { canonicalizeStreamEndpoint } = require("./byteStreamEndpoint.cjs");

const contractSchema = require("./generated/plugin-contract.schema.json");

const PLUGIN_PERMISSIONS = new Set(contractSchema.$defs.PluginPermission.enum);
const RESOURCE_SCOPED_PERMISSIONS = new Set(
  contractSchema.$defs.ResourceScopedPermission.enum,
);

function assertPluginPermission(permission) {
  if (!PLUGIN_PERMISSIONS.has(permission)) {
    throw new TypeError(`Unknown plugin permission: ${String(permission)}`);
  }
  return permission;
}

function canonicalizeNetworkOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new TypeError("Plugin network origin is invalid");
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new TypeError("Plugin network origin is invalid"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Plugin network access supports only HTTP and HTTPS origins");
  }
  if (
    parsed.username
    || parsed.password
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new TypeError("Plugin network grants must contain an origin without credentials or a path");
  return parsed.origin;
}

function canonicalizeCompanionResource(value) {
  if (
    typeof value !== "string"
    || value.length < 5
    || value.length > 192
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/u.test(value)
  ) throw new TypeError("Plugin companion resource is invalid");
  return value;
}

function canonicalizeFilesystemResource(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw new TypeError("Plugin filesystem grants require an absolute canonical path");
  }
  return path.normalize(value);
}

function canonicalizePermissionResource(permission, resource) {
  assertPluginPermission(permission);
  if (permission === "network.stream") return canonicalizeStreamEndpoint(resource).endpoint;
  if (resource === "*") return resource;
  if (permission === "network") return canonicalizeNetworkOrigin(resource);
  if (permission === "companion.execute") return canonicalizeCompanionResource(resource);
  if (permission === "filesystem.read" || permission === "filesystem.write") {
    return canonicalizeFilesystemResource(resource);
  }
  if (typeof resource !== "string" || resource.length < 1 || resource.length > 2_048) {
    throw new TypeError("Plugin permission resource is invalid");
  }
  return resource;
}

function normalizeForFilesystemComparison(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function permissionResourceCovers(
  permission,
  grantResource,
  requestedResource,
  resourceKind = "exact",
  requestedResourceKind = "exact",
) {
  if (permission === "network.stream") return grantResource !== "*" && grantResource === requestedResource;
  if (grantResource === "*") return true;
  if (permission === "filesystem.read" || permission === "filesystem.write") {
    if (requestedResourceKind === "directory" && resourceKind !== "directory") return false;
    const parent = normalizeForFilesystemComparison(grantResource);
    const candidate = normalizeForFilesystemComparison(requestedResource);
    if (resourceKind !== "directory") return parent === candidate;
    const relative = path.relative(parent, candidate);
    return relative === ""
      || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  }
  return grantResource === requestedResource;
}

function normalizePermissionDeclarations(manifest) {
  const declarations = new Map();
  for (const [required, values] of [
    [true, manifest?.permissions?.required ?? []],
    [false, manifest?.permissions?.optional ?? []],
  ]) {
    for (const value of values) {
      const permission = assertPluginPermission(typeof value === "string" ? value : value.permission);
      const resources = typeof value === "string"
        ? []
        : [...new Set((value.resources ?? []).map((resource) => (
            canonicalizePermissionResource(permission, resource)
          )))].sort();
      if ((required && RESOURCE_SCOPED_PERMISSIONS.has(permission)) || permission === "network.stream") {
        if (resources.length === 0) {
          throw new TypeError(`Required permission ${permission} must declare resources`);
        }
        if (resources.includes("*")) {
          throw new TypeError(`Required permission ${permission} must not use wildcard resources`);
        }
      }
      declarations.set(permission, Object.freeze({
        permission,
        required,
        resources: Object.freeze(resources),
        reason: typeof value === "string" ? "" : value.reason ?? "",
      }));
    }
  }
  return declarations;
}

function defaultSecurityPrincipal(manifest, archiveSha256) {
  if (!manifest || typeof manifest.id !== "string" || typeof manifest.publisher !== "string") {
    throw new TypeError("Plugin security principal requires manifest identity");
  }
  if (
    archiveSha256 !== undefined
    && (typeof archiveSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(archiveSha256))
  ) throw new TypeError("Plugin security principal package digest is invalid");
  const digest = createHash("sha256")
    .update(manifest.id)
    .update("\0")
    .update(manifest.publisher)
    .update("\0")
    .update(archiveSha256 ?? "unbound-development-package")
    .digest("hex");
  return `${archiveSha256 ? "unsigned-package" : "unsigned-development"}:${digest}`;
}

function assertSecurityPrincipal(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 256 || value.includes("\0")) {
    throw new TypeError("Plugin security principal is invalid");
  }
  return value;
}

function permissionDeclarationHash(declaration, securityPrincipal = "legacy:unbound-principal") {
  return createHash("sha256").update(JSON.stringify({
    permission: declaration.permission,
    required: declaration.required,
    resources: [...declaration.resources].sort(),
    securityPrincipal: assertSecurityPrincipal(securityPrincipal),
  })).digest("hex");
}

function declarationAllowsResource(declaration, requestedResource) {
  if (declaration.resources.length === 0) return true;
  return declaration.resources.some((resource) => permissionResourceCovers(
    declaration.permission,
    resource,
    requestedResource,
    declaration.permission === "filesystem.read" || declaration.permission === "filesystem.write"
      ? "directory"
      : "exact",
  ));
}

module.exports = {
  PLUGIN_PERMISSIONS,
  RESOURCE_SCOPED_PERMISSIONS,
  assertPluginPermission,
  assertSecurityPrincipal,
  canonicalizeCompanionResource,
  canonicalizeFilesystemResource,
  canonicalizeNetworkOrigin,
  canonicalizePermissionResource,
  declarationAllowsResource,
  defaultSecurityPrincipal,
  normalizePermissionDeclarations,
  permissionDeclarationHash,
  permissionResourceCovers,
};
