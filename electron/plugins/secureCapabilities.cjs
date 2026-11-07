"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { assertSecretKey } = require("./secretStore.cjs");

function assertSecretParams(params, options = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret parameters are invalid");
  }
  const key = assertSecretKey(params.key);
  if (options.value) {
    if (typeof params.value !== "string") {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret value is invalid");
    }
    return { key, value: params.value };
  }
  return { key };
}

function secretAuthorization(params, action) {
  const value = assertSecretParams(params);
  return {
    permission: "secrets",
    resources: [`secret:${value.key}`],
    reason: `${action} plugin secret ${value.key}`,
    operationId: `secret:${action.toLowerCase()}:${value.key}`,
  };
}

function registerSecurePluginCapabilities(registry, options) {
  registry.use(options.quotaManager.createMiddleware());
  registry.use(options.permissionEngine.createMiddleware());

  registry.registerRequest("secrets.get", async ({ key }, context) => {
    const secret = options.secretStore.getReference(context.pluginId, key);
    return secret ? { found: true, secret } : { found: false };
  }, {
    metadata: { capability: "secrets", mutating: false, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params),
    authorization: (params) => secretAuthorization(params, "Read"),
  });
  registry.registerRequest("secrets.set", async ({ key, value }, context) => {
    await context.assertActive();
    return { secret: options.secretStore.set(context.pluginId, key, value) };
  }, {
    metadata: { capability: "secrets", mutating: true, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params, { value: true }),
    authorization: (params) => secretAuthorization(params, "Store"),
  });
  registry.registerRequest("secrets.delete", async ({ key }, context) => {
    await context.assertActive();
    options.secretStore.delete(context.pluginId, key);
    return null;
  }, {
    metadata: { capability: "secrets", mutating: true, permission: "secrets" },
    validateParams: (params) => assertSecretParams(params),
    authorization: (params) => secretAuthorization(params, "Delete"),
  });

  registry.registerRequest("credentials.createLease", (params, context) => (
    options.credentialBroker.createLease(params, context)
  ), {
    metadata: { capability: "credentials", mutating: true, permission: "secrets" },
    validateParams: options.assertLeaseParams,
    authorization: (params) => options.credentialBroker.describeAuthorization(params),
  });

  registry.registerRequest("network.request", async (params, context) => {
    // params are already registry-validated (preserve credentialLease/authorization).
    const validated = params;
    const lease = validated?.credentialLease;
    if (lease === undefined) {
      return options.networkBroker.request(validated, context);
    }
    if (!options.credentialBroker || typeof options.credentialBroker.consumeLease !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin credential leases are unavailable");
    }
    // Bind consumption to the host-owned network operation id (network:<origin>),
    // not the plugin-echoed lease.operationId, so leases cannot be replayed across ops.
    const hostOperationId = options.networkBroker.describeAuthorization(validated).operationId;
    const plaintext = await options.credentialBroker.consumeLease(
      context,
      lease,
      hostOperationId,
    );
    if (typeof plaintext !== "string" || plaintext.length < 1) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin credential lease resolved to an empty secret");
    }
    const authorization = validated?.authorization && typeof validated.authorization === "object"
      && !Array.isArray(validated.authorization)
      ? validated.authorization
      : { scheme: "Bearer" };
    const scheme = authorization.scheme === "Basic" ? "Basic" : "Bearer";
    const headers = { ...(validated.headers ?? {}) };
    if (scheme === "Basic") {
      const username = typeof authorization.username === "string" ? authorization.username : "";
      headers.authorization = `Basic ${Buffer.from(`${username}:${plaintext}`, "utf8").toString("base64")}`;
    } else {
      headers.authorization = `Bearer ${plaintext}`;
    }
    const { credentialLease: _lease, authorization: _auth, ...requestParams } = validated;
    return options.networkBroker.request({
      ...requestParams,
      headers,
    }, context);
  }, {
    metadata: { capability: "network", mutating: true, permission: "network" },
    validateParams: (params) => options.networkBroker.validate(params),
    authorization: (params) => options.networkBroker.describeAuthorization(params),
  });

  registry.registerRequest("filesystem.readFile", (params, context) => (
    options.filesystemBroker.readFile(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validateRead(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params, "exact"),
  });
  registry.registerRequest("filesystem.stat", (params, context) => (
    options.filesystemBroker.stat(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validatePath(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params, "exact"),
  });
  registry.registerRequest("filesystem.readDirectory", (params, context) => (
    options.filesystemBroker.readDirectory(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: false, permission: "filesystem.read" },
    validateParams: (params) => options.filesystemBroker.validateDirectory(params),
    authorization: (params) => options.filesystemBroker.describeReadAuthorization(params, "directory"),
  });
  registry.registerRequest("filesystem.writeFile", (params, context) => (
    options.filesystemBroker.writeFile(params, context)
  ), {
    metadata: { capability: "filesystem", mutating: true, permission: "filesystem.write" },
    validateParams: (params) => options.filesystemBroker.validateWrite(params),
    authorization: (params) => options.filesystemBroker.describeWriteAuthorization(params),
  });

  registry.registerRequest("companion.start", (params, context) => (
    options.companionSupervisor.start(params, context)
  ), {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateStart(params),
    authorization: (params, context) => (
      options.companionSupervisor.describeStartAuthorization(params, context)
    ),
  });
  registry.registerRequest("companion.request", async (params, context) => {
    const validated = options.companionSupervisor.validateRequest(params);
    if (validated.credentialLeases === undefined) {
      return options.companionSupervisor.request(validated, context);
    }
    const credentials = {};
    for (const [name, lease] of Object.entries(validated.credentialLeases)) {
      credentials[name] = await options.credentialBroker.consumeLease(
        context,
        lease,
        validated.operationId,
      );
    }
    await context.assertActive();
    return options.companionSupervisor.request({
      handleId: validated.handleId,
      method: validated.method,
      params: Object.freeze({
        payload: validated.params ?? null,
        credentials: Object.freeze(credentials),
      }),
      timeoutMs: validated.timeoutMs,
    }, context);
  }, {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateRequest(params),
    authorization: (params, context) => options.companionSupervisor.describeHandleAuthorization(params, context),
  });
  registry.registerRequest("companion.stop", (params, context) => (
    options.companionSupervisor.stop(params, context)
  ), {
    metadata: { capability: "companion", mutating: true, permission: "companion.execute" },
    validateParams: (params) => options.companionSupervisor.validateStop(params),
    authorization: (params, context) => options.companionSupervisor.describeHandleAuthorization(params, context),
  });
}

module.exports = { assertSecretParams, registerSecurePluginCapabilities, secretAuthorization };
