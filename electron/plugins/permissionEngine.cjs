"use strict";

const { createHash, randomUUID } = require("node:crypto");

const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const {
  assertPluginPermission,
  canonicalizePermissionResource,
  declarationAllowsResource,
  defaultSecurityPrincipal,
  normalizePermissionDeclarations,
  permissionDeclarationHash,
  permissionResourceCovers,
} = require("./permissionResources.cjs");

const VALID_SCOPES = new Set(["once", "session", "application", "always"]);
const AUDITED_PERMISSION_USES = new Set([
  "runtime.advanced",
  "network",
  "filesystem.read",
  "filesystem.write",
  "secrets",
  "companion.execute",
  "vault.credentials",
  "terminal.input",
  "terminal.intercept.input",
  "terminal.intercept.output",
]);
const PROMPT_TIMEOUT_MS = 30_000;
const PERMISSION_GRANT_SCOPES = new Set(["once", "session", "application", "always"]);
const HOST_PERMISSION_REASONS = Object.freeze({
  "terminal.intercept.input": "This plugin can inspect and rewrite Terminal input. Netcatty bypasses host-recognized credential input, but arbitrary no-echo input may not be detectable.",
});

function normalizePermissionOperationId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    throw permissionDenied("Plugin permission operation ID is invalid");
  }
  if (value.length <= 128) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePermissionReason(value, permission) {
  const reason = typeof value === "string" && value.length > 0
    ? value
    : `Allow ${permission}`;
  if (reason.length <= 1_024) return reason;
  const suffix = ` [sha256:${createHash("sha256").update(reason).digest("hex")}]`;
  return `${reason.slice(0, 1_024 - suffix.length)}${suffix}`;
}

function normalizePermissionSessionId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw permissionDenied("Plugin permission session ID is invalid");
  }
  return value;
}

function normalizePermissionAllowedScopes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw permissionDenied("Plugin permission grant scopes are invalid");
  }
  const scopes = [...new Set(value)];
  if (scopes.some((scope) => !PERMISSION_GRANT_SCOPES.has(scope))) {
    throw permissionDenied("Plugin permission grant scopes are invalid");
  }
  return Object.freeze(scopes);
}

function normalizePermissionResources(permission, values, label = "Plugin permission resources") {
  return normalizePermissionResourceDescriptors(permission, values, undefined, label)
    .map(({ resource }) => resource);
}

function normalizePermissionResourceDescriptors(
  permission,
  values,
  resourceKinds,
  label = "Plugin permission resources",
) {
  try {
    if (
      resourceKinds !== undefined
      && (!Array.isArray(resourceKinds) || resourceKinds.length !== values.length)
    ) throw new TypeError("Resource kinds must align with resources");
    const descriptors = new Map();
    for (const [index, value] of values.entries()) {
      const resource = canonicalizePermissionResource(permission, value);
      const resourceKind = resourceKinds?.[index] ?? "exact";
      if (
        (resourceKind !== "exact" && resourceKind !== "directory")
        || (resourceKind === "directory"
          && permission !== "filesystem.read"
          && permission !== "filesystem.write")
        || (resource === "*" && resourceKind !== "exact")
      ) throw new TypeError("Resource kind is invalid");
      const previous = descriptors.get(resource);
      if (previous && previous.resourceKind !== resourceKind) {
        throw new TypeError("Duplicate resources cannot have conflicting kinds");
      }
      descriptors.set(resource, Object.freeze({ resource, resourceKind }));
    }
    return [...descriptors.values()].sort((left, right) => (
      left.resource.localeCompare(right.resource, "en")
    ));
  } catch {
    throw permissionDenied(`${label} are invalid`, { permission });
  }
}

function permissionDenied(message, details) {
  return new PluginRpcError(RPC_ERRORS.permissionDenied, message, {
    pluginCode: "permission_denied",
    ...(details === undefined ? {} : { details }),
  });
}

function normalizeDecision(decision, requestId) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw permissionDenied("Plugin permission request was not approved");
  }
  if (decision.requestId !== requestId) {
    throw permissionDenied("Plugin permission decision does not match the pending request");
  }
  if (decision.decision === "deny" || decision.decision === "cancel") {
    if (Object.keys(decision).some((key) => key !== "requestId" && key !== "decision")) {
      throw permissionDenied("Plugin permission decision is invalid");
    }
    return Object.freeze({ requestId, decision: decision.decision });
  }
  if (decision.decision !== "allow" || !VALID_SCOPES.has(decision.scope)) {
    throw permissionDenied("Plugin permission decision is invalid");
  }
  if (Object.keys(decision).some((key) => (
    key !== "requestId" && key !== "decision" && key !== "scope" && key !== "resources"
  ))) throw permissionDenied("Plugin permission decision is invalid");
  if (
    decision.resources !== undefined
    && (!Array.isArray(decision.resources) || decision.resources.length > 128)
  ) throw permissionDenied("Plugin permission decision resources are invalid");
  return Object.freeze({
    requestId,
    decision: "allow",
    scope: decision.scope,
    ...(decision.resources === undefined
      ? {}
      : { resources: Object.freeze([...decision.resources]) }),
  });
}

function immutableRequest(request) {
  return Object.freeze({
    ...request,
    resources: Object.freeze([...request.resources]),
    resourceKinds: Object.freeze([...request.resourceKinds]),
  });
}

class PluginPermissionEngine {
  constructor(options) {
    this.database = options.database;
    this.requestDecision = options.requestDecision ?? null;
    if (this.requestDecision != null && typeof this.requestDecision !== "function") {
      throw new TypeError("Plugin permission decision provider must be a function");
    }
    this.clock = options.clock ?? (() => Date.now());
    this.promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
    this.applicationGrants = new Map();
    this.sessionGrants = new Map();
    this.pending = new Map();
    this.sessionPromptControllers = new Map();
    this.promptControllers = new Set();
    this.revocationListeners = new Set();
    this.closed = false;
    this.shutdownController = new AbortController();
  }

  onDidRevoke(listener) {
    if (typeof listener !== "function") throw new TypeError("Permission revocation listener is required");
    this.revocationListeners.add(listener);
    return Object.freeze({ dispose: () => this.revocationListeners.delete(listener) });
  }

  #emitRevocation(event) {
    const frozen = Object.freeze({ ...event });
    for (const listener of this.revocationListeners) {
      try { listener(frozen); } catch {}
    }
  }

  #abortPrompts(pluginId, permission, resource) {
    for (const entry of this.promptControllers) {
      if (entry.pluginId !== pluginId) continue;
      if (permission !== undefined && entry.permission !== permission) continue;
      if (resource !== undefined && !entry.resources.includes(resource)) continue;
      entry.controller.abort(permissionDenied("Plugin permission was revoked"));
    }
  }

  #grantKey(pluginId, permission, declarationHash, resource) {
    return `${pluginId}\0${permission}\0${declarationHash}\0${resource}`;
  }

  #sessionGrantKey(sessionId, grantKey) {
    return `${sessionId}\0${grantKey}`;
  }

  #createMemoryGrant(
    context,
    permission,
    declarationHash,
    resource,
    resourceKind,
    scope,
    sessionId,
  ) {
    return Object.freeze({
      pluginId: context.pluginId,
      permission,
      declarationHash,
      resource,
      resourceKind,
      scope,
      sessionId: sessionId ?? null,
      grantedAt: this.clock(),
    });
  }

  #memoryGrantCovers(
    grant,
    context,
    permission,
    declarationHash,
    resource,
    resourceKind,
    sessionId,
  ) {
    return grant.pluginId === context.pluginId
      && grant.permission === permission
      && grant.declarationHash === declarationHash
      && (grant.scope !== "session" || grant.sessionId === sessionId)
      && permissionResourceCovers(
        permission,
        grant.resource,
        resource,
        grant.resourceKind,
        resourceKind,
      );
  }

  #assertDeclared(context, permission, resources) {
    const declarations = normalizePermissionDeclarations(context.manifest);
    const declaration = declarations.get(permission);
    if (!declaration) {
      throw permissionDenied(`Plugin did not declare permission: ${permission}`, { permission });
    }
    for (const resource of resources) {
      if (!declarationAllowsResource(declaration, resource)) {
        throw permissionDenied(`Plugin did not declare permission resource: ${permission}`, {
          permission,
          resource,
        });
      }
    }
    const securityPrincipal = context.securityPrincipal ?? defaultSecurityPrincipal(context.manifest);
    return {
      declaration,
      declarationHash: permissionDeclarationHash(declaration, securityPrincipal),
      securityPrincipal,
    };
  }

  #hasGrant(context, permission, declarationHash, resource, resourceKind, sessionId) {
    if ([...this.applicationGrants.values()].some((grant) => (
      this.#memoryGrantCovers(
        grant,
        context,
        permission,
        declarationHash,
        resource,
        resourceKind,
        sessionId,
      )
    ))) return true;
    if (sessionId && [...this.sessionGrants.values()].some((grant) => (
      this.#memoryGrantCovers(
        grant,
        context,
        permission,
        declarationHash,
        resource,
        resourceKind,
        sessionId,
      )
    ))) return true;
    return this.database.listPermissionGrants(context.pluginId).some((grant) => (
      grant.permission === permission
      && grant.declarationHash === declarationHash
      && permissionResourceCovers(
        permission,
        grant.resource,
        resource,
        grant.resourceKind,
        resourceKind,
      )
    ));
  }

  #hasAllGrants(context, permission, declarationHash, resources, resourceKinds, sessionId) {
    return resources.every((resource, index) => this.#hasGrant(
      context,
      permission,
      declarationHash,
      resource,
      resourceKinds[index],
      sessionId,
    ));
  }

  async authorize(context, descriptor) {
    if (this.closed) throw permissionDenied("Plugin permission engine is unavailable");
    context.signal?.throwIfAborted();
    const permission = descriptor.permission;
    if (
      descriptor.resources !== undefined
      && (!Array.isArray(descriptor.resources) || descriptor.resources.length > 128)
    ) throw permissionDenied("Plugin permission resources are invalid");
    if (
      descriptor.resourceKinds !== undefined
      && (
        !Array.isArray(descriptor.resourceKinds)
        || descriptor.resourceKinds.length > 128
        || !Array.isArray(descriptor.resources)
        || descriptor.resourceKinds.length !== descriptor.resources.length
      )
    ) throw permissionDenied("Plugin permission resource kinds are invalid");
    descriptor = Object.freeze({
      ...descriptor,
      reason: normalizePermissionReason(
        HOST_PERMISSION_REASONS[permission] ?? descriptor.reason,
        permission,
      ),
      operationId: normalizePermissionOperationId(descriptor.operationId),
      sessionId: normalizePermissionSessionId(descriptor.sessionId),
      allowedScopes: normalizePermissionAllowedScopes(descriptor.allowedScopes),
    });
    const resourceDescriptors = normalizePermissionResourceDescriptors(
      permission,
      descriptor.resources?.length ? descriptor.resources : ["*"],
      descriptor.resources?.length ? descriptor.resourceKinds : undefined,
    );
    const resources = resourceDescriptors.map(({ resource }) => resource);
    const resourceKinds = resourceDescriptors.map(({ resourceKind }) => resourceKind);
    const { declaration, declarationHash } = this.#assertDeclared(context, permission, resources);
    if (this.#hasAllGrants(
      context,
      permission,
      declarationHash,
      resources,
      resourceKinds,
      descriptor.sessionId,
    )) {
      if (AUDITED_PERMISSION_USES.has(permission)) {
        this.database.recordSecurityAudit(context.pluginId, "permission.used", {
          permission,
          resources,
          resourceKinds,
          runtimeId: context.runtimeId ?? null,
          operationId: descriptor.operationId ?? null,
        });
      }
      return Object.freeze({ declaration, resources, scope: "existing" });
    }
    if (descriptor.interactive === false || !this.requestDecision) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission,
        resources,
        reason: "no-interactive-approver",
      });
      throw permissionDenied(`Plugin permission is not granted: ${permission}`, {
        permission,
        resources,
      });
    }
    const pendingKey = JSON.stringify([
      context.pluginId,
      context.runtimeId ?? null,
      permission,
      declarationHash,
      resources,
      resourceKinds,
      descriptor.operationId ?? null,
      descriptor.sessionId ?? null,
      descriptor.allowedScopes ?? null,
    ]);
    let pending = this.pending.get(pendingKey);
    let ownsPrompt = false;
    if (!pending) {
      ownsPrompt = true;
      pending = this.#requestGrant(
        context,
        descriptor,
        resources,
        resourceKinds,
        declaration,
        declarationHash,
      )
        .finally(() => this.pending.delete(pendingKey));
      this.pending.set(pendingKey, pending);
    }
    const grant = await pending;
    context.signal?.throwIfAborted();
    if (!ownsPrompt && grant.scope === "once") {
      return this.authorize(context, descriptor);
    }
    return Object.freeze({ declaration, resources, scope: grant.scope });
  }

  async #requestGrant(
    context,
    descriptor,
    resources,
    resourceKinds,
    declaration,
    declarationHash,
  ) {
    const requestId = randomUUID();
    const request = immutableRequest({
      requestId,
      pluginId: context.pluginId,
      ...(context.pluginVersion === undefined ? {} : { pluginVersion: context.pluginVersion }),
      ...(context.manifest?.name === undefined ? {} : { pluginName: context.manifest.name }),
      ...(context.manifest?.publisher === undefined ? {} : { publisher: context.manifest.publisher }),
      runtimeId: context.runtimeId ?? null,
      runtimeKind: context.runtimeKind ?? null,
      permission: descriptor.permission,
      resources,
      resourceKinds,
      reason: descriptor.reason,
      ...(descriptor.operationId === undefined ? {} : { operationId: descriptor.operationId }),
      ...(descriptor.sessionId === undefined ? {} : { sessionId: descriptor.sessionId }),
      ...(descriptor.allowedScopes === undefined ? {} : { allowedScopes: descriptor.allowedScopes }),
    });
    const controller = new AbortController();
    const promptEntry = Object.freeze({
      controller,
      pluginId: context.pluginId,
      permission: descriptor.permission,
      resources: Object.freeze([...resources]),
    });
    this.promptControllers.add(promptEntry);
    if (descriptor.sessionId) {
      const controllers = this.sessionPromptControllers.get(descriptor.sessionId) ?? new Set();
      controllers.add(controller);
      this.sessionPromptControllers.set(descriptor.sessionId, controllers);
    }
    const timer = setTimeout(() => controller.abort(permissionDenied(
      "Plugin permission request timed out",
    )), this.promptTimeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(context.signal.reason);
    const onShutdown = () => controller.abort(this.shutdownController.signal.reason);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    this.shutdownController.signal.addEventListener("abort", onShutdown, { once: true });
    let rawDecision;
    try {
      rawDecision = await raceWithAbort(
        Promise.resolve(this.requestDecision(request, { signal: controller.signal })),
        controller.signal,
      );
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: controller.signal.aborted ? "prompt-aborted" : "decision-provider-failed",
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      throw permissionDenied("Plugin permission decision provider failed", {
        permission: descriptor.permission,
      });
    } finally {
      clearTimeout(timer);
      this.promptControllers.delete(promptEntry);
      context.signal?.removeEventListener("abort", onAbort);
      this.shutdownController.signal.removeEventListener("abort", onShutdown);
      if (descriptor.sessionId) {
        const controllers = this.sessionPromptControllers.get(descriptor.sessionId);
        controllers?.delete(controller);
        if (controllers?.size === 0) this.sessionPromptControllers.delete(descriptor.sessionId);
      }
    }
    if (this.closed) throw permissionDenied("Plugin permission engine is unavailable");
    let decision;
    try {
      decision = normalizeDecision(rawDecision, requestId);
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: "invalid-decision",
      });
      throw error;
    }
    if (decision.decision !== "allow") {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        decision: decision.decision,
      });
      const outcome = decision.decision === "deny" ? "denied" : "cancelled";
      throw permissionDenied(`Plugin permission was ${outcome}: ${descriptor.permission}`);
    }
    if (descriptor.allowedScopes && !descriptor.allowedScopes.includes(decision.scope)) {
      throw permissionDenied(`Plugin permission scope is not supported for this operation: ${decision.scope}`);
    }
    let decisionResources;
    try {
      decisionResources = normalizePermissionResources(
        descriptor.permission,
        decision.resources === undefined ? resources : decision.resources,
        "Plugin permission decision resources",
      );
    } catch (error) {
      this.database.recordSecurityAudit(context.pluginId, "permission.denied", {
        permission: descriptor.permission,
        resources,
        reason: "invalid-decision-resources",
      });
      throw error;
    }
    if (!decisionResources.every((resource) => declarationAllowsResource(declaration, resource))) {
      throw permissionDenied("Plugin permission decision exceeds the manifest declaration");
    }
    const decisionResourceDescriptors = decisionResources.map((resource) => {
      const requestedIndex = resources.indexOf(resource);
      return Object.freeze({
        resource,
        resourceKind: requestedIndex === -1 ? "exact" : resourceKinds[requestedIndex],
      });
    });
    if (!resources.every((requested) => decisionResourceDescriptors.some((granted) => (
      permissionResourceCovers(
        descriptor.permission,
        granted.resource,
        requested,
        granted.resourceKind,
        resourceKinds[resources.indexOf(requested)],
      )
    )))) {
      throw permissionDenied("Plugin permission decision does not cover the requested resources");
    }
    if (decision.scope === "session" && !descriptor.sessionId) {
      throw permissionDenied("Session-scoped plugin permission requires a host-owned session");
    }
    context.signal?.throwIfAborted();
    descriptor.validateBeforeGrant?.();
    for (const { resource, resourceKind } of decisionResourceDescriptors) {
      const grantKey = this.#grantKey(
        context.pluginId,
        descriptor.permission,
        declarationHash,
        resource,
      );
      if (decision.scope === "application") {
        this.applicationGrants.set(grantKey, this.#createMemoryGrant(
          context,
          descriptor.permission,
          declarationHash,
          resource,
          resourceKind,
          decision.scope,
        ));
      }
      if (decision.scope === "session") {
        this.sessionGrants.set(
          this.#sessionGrantKey(descriptor.sessionId, grantKey),
          this.#createMemoryGrant(
            context,
            descriptor.permission,
            declarationHash,
            resource,
            resourceKind,
            decision.scope,
            descriptor.sessionId,
          ),
        );
      }
      if (decision.scope === "always") {
        this.database.upsertPermissionGrant({
          pluginId: context.pluginId,
          permission: descriptor.permission,
          resource,
          resourceKind,
          declarationHash,
        });
      }
    }
    this.database.recordSecurityAudit(context.pluginId, "permission.granted", {
      permission: descriptor.permission,
      resources: decisionResources,
      resourceKinds: decisionResourceDescriptors.map(({ resourceKind }) => resourceKind),
      scope: decision.scope,
      operationId: descriptor.operationId ?? null,
    });
    return decision;
  }

  async authorizeRequired(plugin, options = {}) {
    const declarations = normalizePermissionDeclarations(plugin.manifest);
    const skipPermissions = new Set(options.skipPermissions ?? []);
    const context = {
      pluginId: plugin.id,
      pluginVersion: plugin.activeVersion,
      runtimeId: options.runtimeId ?? null,
      manifest: plugin.manifest,
      securityPrincipal: options.securityPrincipal,
      signal: options.signal,
    };
    for (const declaration of declarations.values()) {
      if (!declaration.required || skipPermissions.has(declaration.permission)) continue;
      await this.authorize(context, {
        permission: declaration.permission,
        resources: declaration.resources.length ? declaration.resources : ["*"],
        ...(declaration.resources.length
          && (declaration.permission === "filesystem.read"
            || declaration.permission === "filesystem.write")
          ? { resourceKinds: declaration.resources.map(() => "directory") }
          : {}),
        reason: declaration.reason || `Required by ${plugin.id}`,
        operationId: `activation:${plugin.activeVersion}`,
      });
    }
  }

  createMiddleware() {
    return async (context, next) => {
      if (context.metadata.public === true) return next();
      if (!context.authorization) {
        throw permissionDenied(`Plugin host method has no authorization policy: ${context.method}`);
      }
      await this.authorize(context, context.authorization);
      return next();
    };
  }

  listGrants(pluginId) {
    return Object.freeze({
      always: Object.freeze(this.database.listPermissionGrants(pluginId).map((grant) => (
        Object.freeze({ ...grant, scope: "always", sessionId: null })
      ))),
      application: Object.freeze([...this.applicationGrants.values()].filter((grant) => (
        grant.pluginId === pluginId
      ))),
      session: Object.freeze([...this.sessionGrants.values()].filter((grant) => (
        grant.pluginId === pluginId
      ))),
    });
  }

  revokeAlways(pluginId, permission, resource) {
    assertPluginPermission(permission);
    const canonicalResource = canonicalizePermissionResource(permission, resource);
    this.database.deletePermissionGrant(
      pluginId,
      permission,
      canonicalResource,
    );
    this.database.recordSecurityAudit(pluginId, "permission.revoked", {
      scope: "always",
      permission,
      resource: canonicalResource,
    });
    this.#abortPrompts(pluginId, permission, canonicalResource);
    this.#emitRevocation({ pluginId, permission, resource: canonicalResource, scope: "always" });
  }

  revokeApplication(pluginId, permission, resource) {
    if (permission !== undefined) assertPluginPermission(permission);
    if (resource !== undefined && permission === undefined) {
      throw new TypeError("Revoking a permission resource requires a permission name");
    }
    const canonicalResource = resource === undefined
      ? undefined
      : canonicalizePermissionResource(permission, resource);
    for (const [key, grant] of [...this.applicationGrants]) {
      if (
        grant.pluginId === pluginId
        && (permission === undefined || grant.permission === permission)
        && (canonicalResource === undefined || grant.resource === canonicalResource)
      ) this.applicationGrants.delete(key);
    }
    this.database.recordSecurityAudit(pluginId, "permission.revoked", {
      scope: "application",
      ...(permission === undefined ? {} : { permission }),
      ...(canonicalResource === undefined ? {} : { resource: canonicalResource }),
    });
    this.#abortPrompts(pluginId, permission, canonicalResource);
    this.#emitRevocation({
      pluginId,
      ...(permission === undefined ? {} : { permission }),
      ...(canonicalResource === undefined ? {} : { resource: canonicalResource }),
      scope: "application",
    });
  }

  revokeSession(sessionId) {
    const controllers = this.sessionPromptControllers.get(sessionId);
    this.sessionPromptControllers.delete(sessionId);
    for (const controller of controllers ?? []) {
      controller.abort(permissionDenied("Plugin permission request session ended"));
    }
    for (const key of [...this.sessionGrants.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this.sessionGrants.delete(key);
    }
  }

  revokeAll(pluginId) {
    this.database.deleteAllPermissionGrants(pluginId);
    for (const [key, grant] of [...this.applicationGrants]) {
      if (grant.pluginId === pluginId) this.applicationGrants.delete(key);
    }
    for (const [key, grant] of [...this.sessionGrants]) {
      if (grant.pluginId === pluginId) this.sessionGrants.delete(key);
    }
    this.database.recordSecurityAudit(pluginId, "permission.revoked", { scope: "all" });
    this.#abortPrompts(pluginId);
    this.#emitRevocation({ pluginId, scope: "all" });
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort(permissionDenied("Plugin permission engine is unavailable"));
    this.applicationGrants.clear();
    this.sessionGrants.clear();
    this.promptControllers.clear();
    this.revocationListeners.clear();
  }
}

module.exports = {
  AUDITED_PERMISSION_USES,
  PROMPT_TIMEOUT_MS,
  PluginPermissionEngine,
  normalizePermissionOperationId,
  normalizePermissionReason,
  normalizePermissionResourceDescriptors,
  normalizePermissionResources,
  normalizePermissionSessionId,
  normalizeDecision,
  permissionDenied,
};
