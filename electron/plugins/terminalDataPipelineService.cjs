"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { normalizeTerminalSessionSnapshot } = require("./terminalProviderService.cjs");

const DIRECTIONS = Object.freeze(["input", "output"]);

function runtimeIdentityMatches(left, right) {
  return left?.pluginId === right?.pluginId
    && left?.pluginVersion === right?.pluginVersion
    && left?.runtimeId === right?.runtimeId
    && left?.runtimeKind === right?.runtimeKind
    && left?.securityPrincipal === right?.securityPrincipal;
}

function normalizeActivationIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || identity.pluginId !== activation?.plugin?.id
    || identity.pluginVersion !== activation?.plugin?.activeVersion
    || typeof identity.runtimeId !== "string" || identity.runtimeId.length < 1
    || identity.runtimeKind !== "utility"
    || typeof identity.securityPrincipal !== "string" || identity.securityPrincipal.length < 1) {
    throw new PluginRpcError(
      RPC_ERRORS.unavailable,
      "Terminal interceptor activation identity is unavailable, stale, or not an advanced utility runtime",
    );
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

function terminalSessionSnapshotsEqual(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.hostId === right?.hostId
    && left?.workspaceId === right?.workspaceId
    && left?.protocol === right?.protocol
    && left?.status === right?.status
    && left?.cwd === right?.cwd
    && left?.title === right?.title
    && left?.shellType === right?.shellType
    && left?.cols === right?.cols
    && left?.rows === right?.rows
    && left?.alternateScreen === right?.alternateScreen;
}

class PluginTerminalDataPipelineService {
  constructor(options) {
    if (!options?.contributionService || !options?.permissionEngine
      || !options?.runtimeSupervisor || !options?.MessageChannelMain) {
      throw new TypeError("Terminal data pipeline requires contribution, permission, runtime, and MessagePort services");
    }
    this.contributionService = options.contributionService;
    this.permissionEngine = options.permissionEngine;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.MessageChannelMain = options.MessageChannelMain;
    this.requestSelection = options.requestSelection ?? (async () => null);
    this.showWarning = options.showWarning ?? (() => {});
    this.terminalWorkerManager = null;
    this.workerWarningSubscription = null;
    this.sessionOwnedSubscription = null;
    this.sessionClosedSubscription = null;
    this.active = new Map();
    this.declined = new Set();
    this.quarantined = new Set();
    this.selectedProviders = new Map();
    this.operations = new Map();
    this.pendingActivations = new Map();
    this.failedActivations = new Map();
    this.finalizedActivations = new WeakSet();
    this.permissionGenerations = new Map();
    this.sessionEpochs = new Map();
    this.pendingOwnership = new Map();
    this.closed = false;
    this.permissionRevocationSubscription = this.permissionEngine.onDidRevoke?.((event) => {
      const pluginId = event?.pluginId;
      if (typeof pluginId !== "string") return;
      this.permissionGenerations.set(pluginId, (this.permissionGenerations.get(pluginId) ?? 0) + 1);
      const affectedDirections = event.permission === "terminal.intercept.input"
        ? new Set(["input"])
        : event.permission === "terminal.intercept.output"
          ? new Set(["output"])
          : event.permission === undefined || event.permission === "provider.terminal"
            ? new Set(DIRECTIONS)
            : new Set();
      if (affectedDirections.size === 0) return;
      for (const [key, binding] of [...this.active]) {
        if (binding.identity.pluginId === pluginId && affectedDirections.has(binding.direction)) {
          this.#detachKey(key, "permission-revoked");
        }
      }
      for (const [key, selection] of [...this.selectedProviders]) {
        const direction = key.slice(key.lastIndexOf("\0") + 1);
        if (selection.pluginId === pluginId && affectedDirections.has(direction)) {
          this.selectedProviders.delete(key);
        }
      }
    }) ?? null;
    this.runtimeSupervisor.onDidChangeRuntime?.((event) => {
      if (event.status === "running") return;
      const failed = event.status === "error" || event.status === "quarantined";
      const warnedKeys = new Set();
      for (const [key, selection] of this.selectedProviders) {
        if (selection.pluginId === event.pluginId) {
          this.selectedProviders.delete(key);
        }
      }
      for (const [key, binding] of this.active) {
        if (binding.identity.pluginId === event.pluginId
          && (event.runtimeId == null || binding.identity.runtimeId === event.runtimeId)) {
          if (failed) {
            this.declined.add(key);
            this.quarantined.add(key);
            this.showWarning(Object.freeze({
              sessionId: binding.sessionId,
              direction: binding.direction,
              providerId: binding.providerId,
              code: `runtime-${event.status}`,
              message: event.error
                ?? `Terminal interceptor runtime ${event.status}`,
            }));
            warnedKeys.add(key);
          }
          this.#detachKey(key, failed ? `runtime-${event.status}` : "runtime-stopped");
        }
      }
      for (const [key, pending] of [
        ...this.pendingActivations,
        ...this.failedActivations,
      ]) {
        if ((this.sessionEpochs.get(pending.sessionId) ?? 0) !== pending.sessionEpoch) {
          if (this.failedActivations.get(key) === pending) this.failedActivations.delete(key);
          continue;
        }
        if (pending.identity.pluginId !== event.pluginId
          || (event.runtimeId != null
            && pending.identity.runtimeId != null
            && pending.identity.runtimeId !== event.runtimeId)) {
          continue;
        }
        this.finalizedActivations.add(pending);
        this.selectedProviders.delete(key);
        if (!failed) continue;
        this.declined.add(key);
        this.quarantined.add(key);
        if (!warnedKeys.has(key)) {
          this.showWarning(Object.freeze({
            sessionId: pending.sessionId,
            direction: pending.direction,
            providerId: pending.providerId,
            code: `runtime-${event.status}`,
            message: event.error
              ?? `Terminal interceptor runtime ${event.status}`,
          }));
        }
      }
      for (const [key, pending] of this.failedActivations) {
        if (pending.identity.pluginId === event.pluginId
          && (event.runtimeId == null
            || pending.identity.runtimeId == null
            || pending.identity.runtimeId === event.runtimeId)) {
          this.failedActivations.delete(key);
        }
      }
    });
    this.contributionService.onDidChange?.(() => this.#pruneContributions());
  }

  bindTerminalWorkerManager(manager) {
    this.workerWarningSubscription?.dispose?.();
    this.sessionOwnedSubscription?.dispose?.();
    this.sessionClosedSubscription?.dispose?.();
    this.workerWarningSubscription = null;
    this.sessionOwnedSubscription = null;
    this.sessionClosedSubscription = null;
    this.terminalWorkerManager = manager ?? null;
    if (manager?.onTerminalInterceptorWarning) {
      this.workerWarningSubscription = manager.onTerminalInterceptorWarning((warning) => {
        if (warning?.code === "worker-exit") {
          this.active.clear();
          return;
        }
        const key = `${warning?.sessionId}\0${warning?.direction}`;
        const binding = this.active.get(key);
        if (!binding) return;
        if (warning?.code === "closed" && !runtimeIdentityMatches(
          this.runtimeSupervisor.getRuntimeIdentity(binding.identity.pluginId),
          binding.identity,
        )) {
          // RuntimeSupervisor removes the identity before an expected stop
          // closes the utility port, then publishes the authoritative stopped,
          // error, or quarantined state. Defer classification to that event so
          // planned restarts are not quarantined while crashes still are.
          return;
        }
        this.active.delete(key);
        if (!["detached", "replaced", "shutdown"].includes(warning?.code)) {
          // A circuit-breaker or protocol failure quarantines this direction
          // for the rest of the session. Keeping the cached provider would let
          // the next connected/snapshot event silently reattach the same
          // broken interceptor with its existing grants.
          this.selectedProviders.delete(key);
          this.declined.add(key);
          this.quarantined.add(key);
          this.showWarning(warning);
        }
      });
    }
    if (manager?.onSessionOwned) {
      this.sessionOwnedSubscription = manager.onSessionOwned((event) => (
        this.#handleSessionOwned(event)
      ));
    }
    if (manager?.onSessionClosed) {
      this.sessionClosedSubscription = manager.onSessionClosed((event) => {
        if (typeof event?.sessionId === "string") this.#disposeSession(event.sessionId);
      });
    }
  }

  #disposeSession(sessionId) {
    this.permissionEngine.revokeSession?.(sessionId);
    this.pendingOwnership.delete(sessionId);
    this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
    this.detachSession(sessionId);
    for (const direction of DIRECTIONS) {
      const key = this.#key(sessionId, direction);
      this.declined.delete(key);
      this.quarantined.delete(key);
      this.selectedProviders.delete(key);
      this.failedActivations.delete(key);
    }
  }

  async #handleSessionOwned(event) {
    const pending = this.pendingOwnership.get(event?.sessionId);
    if (!pending || pending.webContentsId !== event?.webContentsId) return;
    this.pendingOwnership.delete(event.sessionId);
    if (this.closed
      || (this.sessionEpochs.get(event.sessionId) ?? 0) !== pending.sessionEpoch
      || !this.terminalWorkerManager?.ownsSession?.(event.sessionId, event.webContentsId)) {
      return;
    }
    await this.handleSessionEvent({ type: "snapshot", session: pending.session }, {
      webContentsId: pending.webContentsId,
      locale: pending.locale,
    });
  }

  #key(sessionId, direction) {
    return `${sessionId}\0${direction}`;
  }

  #providers(direction, locale) {
    const kind = `terminal.interceptor.${direction}`;
    return this.contributionService.listProviders({ kind, locale });
  }

  #pruneContributions() {
    for (const [key, selection] of this.selectedProviders) {
      const direction = key.slice(key.lastIndexOf("\0") + 1);
      if (!this.#providers(direction).some((entry) => (
        entry.provider.id === selection.providerId && entry.pluginId === selection.pluginId
      ))) {
        this.selectedProviders.delete(key);
      }
    }
    for (const [key, binding] of this.active) {
      const providers = this.#providers(binding.direction);
      if (!providers.some((entry) => entry.provider.id === binding.providerId
        && entry.pluginId === binding.identity.pluginId
        && entry.pluginVersion === binding.identity.pluginVersion)) {
        this.#detachKey(key, "contribution-removed");
      }
    }
  }

  #detachKey(key, reason) {
    const binding = this.active.get(key);
    if (!binding) return;
    this.active.delete(key);
    this.terminalWorkerManager?.detachTerminalInterceptor?.(
      binding.sessionId,
      binding.direction,
      reason,
    );
  }

  detachSession(sessionId, reason = "session-disposed") {
    for (const direction of DIRECTIONS) this.#detachKey(this.#key(sessionId, direction), reason);
  }

  async configureDirection(sessionValue, direction, options = {}) {
    const session = normalizeTerminalSessionSnapshot(sessionValue);
    if (!DIRECTIONS.includes(direction)) throw new TypeError("Terminal interceptor direction is invalid");
    const key = this.#key(session.sessionId, direction);
    const epoch = options.sessionEpoch ?? this.sessionEpochs.get(session.sessionId) ?? 0;
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => (
      this.#configureDirection(session, direction, { ...options, sessionEpoch: epoch })
    ));
    this.operations.set(key, operation);
    try { return await operation; }
    finally {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    }
  }

  #assertSessionCurrent(sessionId, epoch) {
    if (this.closed || (this.sessionEpochs.get(sessionId) ?? 0) !== epoch) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Terminal session changed during interceptor activation");
    }
  }

  #assertAttachmentCurrent(session, direction, providerId, identity, options) {
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    if (options.webContentsId != null
      && !this.terminalWorkerManager?.ownsSession?.(session.sessionId, options.webContentsId)) {
      throw new PluginRpcError(
        RPC_ERRORS.permissionDenied,
        "Terminal interceptor session ownership changed during activation",
      );
    }
    const declared = this.#providers(direction).some((entry) => (
      entry.provider.id === providerId
      && entry.pluginId === identity.pluginId
      && entry.pluginVersion === identity.pluginVersion
    ));
    if (!declared) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Terminal interceptor contribution changed during activation",
      );
    }
  }

  acceptsSessionEvent(event, webContentsId) {
    const sessionId = event?.session?.sessionId;
    if (typeof sessionId !== "string" || !Number.isSafeInteger(webContentsId)) return true;
    const currentOwner = this.terminalWorkerManager?.getSessionOwnerWebContentsId?.(sessionId);
    return !Number.isSafeInteger(currentOwner) || currentOwner === webContentsId;
  }

  async #configureDirection(session, direction, options) {
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    if (!this.terminalWorkerManager?.attachTerminalInterceptor) {
      return Object.freeze({ status: "unavailable", direction });
    }
    if (options.webContentsId != null
      && !this.terminalWorkerManager.ownsSession?.(session.sessionId, options.webContentsId)) {
      if (options.deferUntilOwned === true) {
        return Object.freeze({ status: "pending-session", direction });
      }
      throw new PluginRpcError(
        RPC_ERRORS.permissionDenied,
        "Terminal interceptor session is not owned by the requesting window",
      );
    }
    const providers = this.#providers(direction, options.locale);
    if (providers.length === 0) return Object.freeze({ status: "none", direction });
    const key = this.#key(session.sessionId, direction);
    if (this.quarantined.has(key)) {
      return Object.freeze({ status: "declined", direction });
    }
    if (options.providerId == null && this.declined.has(key)) {
      return Object.freeze({ status: "declined", direction });
    }
    const existing = this.active.get(key);
    if (existing && existing.sessionEpoch === options.sessionEpoch
      && terminalSessionSnapshotsEqual(existing.session, session)
      && providers.some((entry) => entry.provider.id === existing.providerId)
      && runtimeIdentityMatches(
        this.runtimeSupervisor.getRuntimeIdentity(existing.identity.pluginId),
        existing.identity,
      )) {
      return Object.freeze({
        status: "active",
        direction,
        providerId: existing.providerId,
        pluginId: existing.identity.pluginId,
      });
    }
    const cachedSelection = this.selectedProviders.get(key);
    let providerId = options.providerId ?? cachedSelection?.providerId;
    if (providerId != null && !providers.some((entry) => entry.provider.id === providerId)) {
      this.selectedProviders.delete(key);
      providerId = options.providerId;
    }
    if (providerId == null && providers.length === 1) providerId = providers[0].provider.id;
    if (providerId == null) {
      providerId = await this.requestSelection(Object.freeze({ session, direction, providers }));
      this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
      if (options.webContentsId != null
        && !this.terminalWorkerManager?.ownsSession?.(session.sessionId, options.webContentsId)) {
        throw new PluginRpcError(
          RPC_ERRORS.permissionDenied,
          "Terminal interceptor session ownership changed during selection",
        );
      }
    }
    if (providerId == null) {
      this.declined.add(key);
      this.selectedProviders.delete(key);
      return Object.freeze({ status: "declined", direction });
    }
    const selected = providers.find((entry) => entry.provider.id === providerId);
    if (!selected) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Selected Terminal interceptor is unavailable");

    const permissionGeneration = this.permissionGenerations.get(selected.pluginId) ?? 0;
    let pendingActivation = Object.freeze({
      sessionId: session.sessionId,
      sessionEpoch: options.sessionEpoch,
      direction,
      providerId,
      identity: Object.freeze({
        pluginId: selected.pluginId,
        pluginVersion: selected.pluginVersion,
        runtimeId: null,
      }),
    });
    this.failedActivations.delete(key);
    this.pendingActivations.set(key, pendingActivation);
    try {
    let activation;
    try {
      activation = await this.contributionService.activateProvider(providerId);
    } catch (error) {
      if ((this.sessionEpochs.get(session.sessionId) ?? 0) === options.sessionEpoch
        && !this.quarantined.has(key)
        && !this.finalizedActivations.has(pendingActivation)) {
        this.failedActivations.set(key, pendingActivation);
      }
      if (this.finalizedActivations.has(pendingActivation) && !this.quarantined.has(key)) {
        throw new PluginRpcError(RPC_ERRORS.cancelled, "Terminal interceptor activation was cancelled");
      }
      throw error;
    }
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    const identity = normalizeActivationIdentity(activation);
    pendingActivation = Object.freeze({
      sessionId: session.sessionId,
      sessionEpoch: options.sessionEpoch,
      direction,
      providerId,
      identity,
    });
    this.pendingActivations.set(key, pendingActivation);
    if (this.quarantined.has(key)) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Terminal interceptor was disabled after a runtime failure",
      );
    }
    if (activation.plugin.manifest.main?.node == null
      || activation.provider.kind !== `terminal.interceptor.${direction}`) {
      throw new PluginRpcError(
        RPC_ERRORS.failedPrecondition,
        "Terminal interceptors require an active advanced utility plugin",
      );
    }
    const context = {
      pluginId: activation.plugin.id,
      pluginVersion: activation.plugin.activeVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
      manifest: activation.plugin.manifest,
      securityPrincipal: identity.securityPrincipal,
    };
    try {
      for (const permission of ["provider.terminal", `terminal.intercept.${direction}`]) {
        const grant = await this.permissionEngine.authorize(context, {
          permission,
          resources: ["*"],
          sessionId: session.sessionId,
          reason: `Use ${providerId} to intercept Terminal ${direction} data`,
          operationId: `terminal.interceptor.${direction}:${providerId}`,
          allowedScopes: ["session", "application", "always"],
          validateBeforeGrant: () => {
            if ((this.permissionGenerations.get(identity.pluginId) ?? 0) !== permissionGeneration) {
              throw new PluginRpcError(
                RPC_ERRORS.permissionDenied,
                "Terminal interceptor permission changed during authorization",
              );
            }
            if (!runtimeIdentityMatches(
              this.runtimeSupervisor.getRuntimeIdentity(identity.pluginId),
              identity,
            )) {
              throw new PluginRpcError(
                RPC_ERRORS.unavailable,
                "Terminal interceptor runtime changed during authorization",
              );
            }
            this.#assertAttachmentCurrent(session, direction, providerId, identity, options);
          },
        });
        if (!["existing", "session", "application", "always"].includes(grant?.scope)) {
          throw new PluginRpcError(
            RPC_ERRORS.permissionDenied,
            "Terminal interceptor streams require a session, application, or persistent permission grant",
          );
        }
        this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
      }
    } catch (error) {
      if (error?.code === RPC_ERRORS.permissionDenied) {
        this.declined.add(key);
        this.selectedProviders.delete(key);
      }
      throw error;
    }
    const currentIdentity = this.runtimeSupervisor.getRuntimeIdentity(activation.plugin.id);
    if ((this.permissionGenerations.get(identity.pluginId) ?? 0) !== permissionGeneration) {
      throw new PluginRpcError(
        RPC_ERRORS.permissionDenied,
        "Terminal interceptor permission changed during activation",
      );
    }
    if (!runtimeIdentityMatches(currentIdentity, identity)) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Terminal interceptor runtime changed during authorization");
    }
    this.#assertAttachmentCurrent(session, direction, providerId, identity, options);

    if (existing?.sessionEpoch === options.sessionEpoch
      && existing.providerId === providerId
      && terminalSessionSnapshotsEqual(existing.session, session)
      && runtimeIdentityMatches(existing.identity, identity)) {
      return Object.freeze({ status: "active", direction, providerId, pluginId: identity.pluginId });
    }
    const channel = new this.MessageChannelMain();
    const utilityDescriptor = Object.freeze({ providerId, direction, session });
    const workerDescriptor = Object.freeze({
      sessionId: session.sessionId,
      direction,
      providerId,
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
      securityPrincipal: identity.securityPrincipal,
      session,
    });
    let workerAttached = false;
    try {
      await this.runtimeSupervisor.attachTerminalInterceptor(
        identity.pluginId,
        utilityDescriptor,
        channel.port2,
        { expectedIdentity: identity },
      );
      if (!runtimeIdentityMatches(
        this.runtimeSupervisor.getRuntimeIdentity(identity.pluginId),
        identity,
      )) {
        throw new PluginRpcError(
          RPC_ERRORS.unavailable,
          "Terminal interceptor runtime changed during port attachment",
        );
      }
      if ((this.permissionGenerations.get(identity.pluginId) ?? 0) !== permissionGeneration) {
        throw new PluginRpcError(
          RPC_ERRORS.permissionDenied,
          "Terminal interceptor permission changed during port attachment",
        );
      }
      if (this.quarantined.has(key)) {
        throw new PluginRpcError(
          RPC_ERRORS.unavailable,
          "Terminal interceptor was disabled after a runtime failure",
        );
      }
      this.#assertAttachmentCurrent(session, direction, providerId, identity, options);
      this.terminalWorkerManager.attachTerminalInterceptor(workerDescriptor, channel.port1);
      workerAttached = true;
    } catch (error) {
      if (!this.finalizedActivations.has(pendingActivation)) {
        this.failedActivations.set(key, pendingActivation);
      }
      if (workerAttached) {
        this.terminalWorkerManager.detachTerminalInterceptor(session.sessionId, direction);
      }
      try { channel.port1.close?.(); } catch {}
      try { channel.port2.close?.(); } catch {}
      if (this.finalizedActivations.has(pendingActivation) && !this.quarantined.has(key)) {
        throw new PluginRpcError(RPC_ERRORS.cancelled, "Terminal interceptor activation was cancelled");
      }
      throw error;
    }
    this.active.set(key, Object.freeze({
      sessionId: session.sessionId,
      direction,
      providerId,
      identity: Object.freeze({ ...identity }),
      sessionEpoch: options.sessionEpoch,
      session,
    }));
    this.failedActivations.delete(key);
    this.declined.delete(key);
    this.selectedProviders.set(key, Object.freeze({
      providerId,
      pluginId: identity.pluginId,
    }));
    return Object.freeze({ status: "active", direction, providerId, pluginId: identity.pluginId });
    } finally {
      if (this.pendingActivations.get(key) === pendingActivation) {
        this.pendingActivations.delete(key);
      }
    }
  }

  async handleSessionEvent(event, options = {}) {
    const session = normalizeTerminalSessionSnapshot(event?.session);
    if (!this.acceptsSessionEvent(event, options.webContentsId)) return Object.freeze([]);
    if (event?.type === "disposed") {
      this.#disposeSession(session.sessionId);
      return Object.freeze([]);
    }
    if (event?.type === "disconnected") {
      const sessionEpoch = (this.sessionEpochs.get(session.sessionId) ?? 0) + 1;
      this.sessionEpochs.set(session.sessionId, sessionEpoch);
      this.detachSession(session.sessionId, "session-disconnected");
      if (Number.isSafeInteger(options.webContentsId)) {
        this.pendingOwnership.set(session.sessionId, Object.freeze({
          session,
          sessionEpoch,
          webContentsId: options.webContentsId,
          locale: options.locale,
        }));
      } else {
        this.pendingOwnership.delete(session.sessionId);
      }
      return Object.freeze([]);
    }
    if (!["created", "connected", "reconnected", "snapshot", "cwdChanged", "titleChanged",
      "resized", "alternateScreenChanged"].includes(event?.type)) {
      return Object.freeze([]);
    }
    if (event.type === "created") {
      this.detachSession(session.sessionId, "session-replaced");
      for (const direction of DIRECTIONS) {
        const key = this.#key(session.sessionId, direction);
        this.declined.delete(key);
        this.quarantined.delete(key);
        this.selectedProviders.delete(key);
        this.failedActivations.delete(key);
      }
      this.sessionEpochs.set(session.sessionId, (this.sessionEpochs.get(session.sessionId) ?? 0) + 1);
    }
    if (!this.sessionEpochs.has(session.sessionId)) this.sessionEpochs.set(session.sessionId, 0);
    const sessionEpoch = this.sessionEpochs.get(session.sessionId) ?? 0;
    if (event.type === "created" && options.webContentsId != null) {
      this.pendingOwnership.set(session.sessionId, Object.freeze({
        session,
        sessionEpoch,
        webContentsId: options.webContentsId,
        locale: options.locale,
      }));
    }
    const results = [];
    for (const direction of DIRECTIONS) {
      try {
        results.push(await this.configureDirection(session, direction, {
          ...options,
          sessionEpoch,
          deferUntilOwned: event.type === "created",
        }));
      }
      catch (error) {
        if (error?.code === RPC_ERRORS.permissionDenied) {
          results.push(Object.freeze({ status: "declined", direction }));
          continue;
        }
        const key = this.#key(session.sessionId, direction);
        if (error?.code === RPC_ERRORS.cancelled
          || (this.sessionEpochs.get(session.sessionId) ?? 0) !== sessionEpoch
          || this.quarantined.has(key)) {
          results.push(Object.freeze({ status: "cancelled", direction }));
          continue;
        }
        this.showWarning(Object.freeze({
          sessionId: session.sessionId,
          direction,
          code: "activation",
          message: error?.message ?? String(error),
        }));
        results.push(Object.freeze({ status: "failed", direction }));
      }
    }
    if (event.type === "created"
      && !results.some((result) => result.status === "pending-session")) {
      this.pendingOwnership.delete(session.sessionId);
    }
    return Object.freeze(results);
  }

  shutdown() {
    this.closed = true;
    for (const sessionId of this.sessionEpochs.keys()) {
      this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
    }
    for (const key of [...this.active.keys()]) this.#detachKey(key, "shutdown");
    this.declined.clear();
    this.quarantined.clear();
    this.selectedProviders.clear();
    this.pendingActivations.clear();
    this.failedActivations.clear();
    this.pendingOwnership.clear();
    this.workerWarningSubscription?.dispose?.();
    this.sessionOwnedSubscription?.dispose?.();
    this.sessionClosedSubscription?.dispose?.();
    this.workerWarningSubscription = null;
    this.sessionOwnedSubscription = null;
    this.sessionClosedSubscription = null;
    this.permissionRevocationSubscription?.dispose?.();
    this.permissionRevocationSubscription = null;
  }
}

module.exports = {
  DIRECTIONS,
  PluginTerminalDataPipelineService,
  normalizeActivationIdentity,
  runtimeIdentityMatches,
};
