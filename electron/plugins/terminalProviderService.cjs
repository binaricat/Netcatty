"use strict";

const { randomUUID } = require("node:crypto");

const {
  assertProviderRequest,
  assertProviderResult,
} = require("./contractValidator.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const { invalidArgument, freezeJson } = require("./validationUtils.cjs");

const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
const MAX_TERMINAL_PROVIDERS_PER_REQUEST = 32;
const DEFAULT_PROVIDER_DEADLINE_MS = 1_500;
const TERMINAL_PROVIDER_KINDS = Object.freeze([
  "terminal.completion",
  "terminal.decoration",
  "terminal.link",
  "terminal.hover",
  "terminal.matcher",
  "terminal.semantic",
  "terminal.prompt",
  "terminal.background",
  "terminal.theme",
]);
const TERMINAL_PROVIDER_KIND_SET = new Set(TERMINAL_PROVIDER_KINDS);
const TERMINAL_PROVIDER_OPERATIONS = new Map([
  ["terminal.completion", "provideCompletions"],
  ["terminal.decoration", "provideDecorations"],
  ["terminal.link", "provideLinks"],
  ["terminal.hover", "provideHovers"],
  ["terminal.matcher", "provideMatches"],
  ["terminal.semantic", "provideSemantics"],
  ["terminal.prompt", "provideAnnotations"],
  ["terminal.background", "provideBackgrounds"],
  ["terminal.theme", "provideTheme"],
]);
const TERMINAL_PROVIDER_PERMISSIONS = new Map([
  ["terminal.completion", ["provider.terminal", "terminal.complete"]],
  ["terminal.decoration", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.link", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.hover", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.matcher", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.semantic", ["provider.terminal", "terminal.input", "terminal.decorate"]],
  ["terminal.prompt", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.background", ["provider.terminal", "terminal.decorate"]],
  ["terminal.theme", ["provider.terminal", "terminal.decorate"]],
]);
const TERMINAL_THEME_COLOR_KEYS = Object.freeze([
  "background", "foreground", "cursor", "selection",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
]);
const TERMINAL_THEME_COLOR_KEY_SET = new Set(TERMINAL_THEME_COLOR_KEYS);
const TERMINAL_EVENT_TYPES = new Set([
  "snapshot",
  "created",
  "connected",
  "reconnected",
  "cwdChanged",
  "titleChanged",
  "resized",
  "alternateScreenChanged",
  "commandSubmitted",
  "commandCompleted",
  "disconnected",
  "disposed",
]);
const TERMINAL_STATUSES = new Set(["connecting", "connected", "disconnected"]);
const TERMINAL_SHELL_TYPES = new Set(["posix", "fish", "powershell", "cmd", "unknown"]);

function assertBoundedJson(value, label) {
  try {
    assertPluginJsonValue(value, { maxBytes: MAX_PROVIDER_JSON_BYTES });
  } catch (error) {
    throw invalidArgument(`${label} must be a bounded JSON value: ${error?.message ?? error}`);
  }
  return value;
}

function assertBoundedString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw invalidArgument(`${label} is invalid`);
  }
  return value;
}

function assertTerminalProviderKind(kind) {
  if (!TERMINAL_PROVIDER_KIND_SET.has(kind)) {
    if (kind === "terminal.interceptor.input" || kind === "terminal.interceptor.output") {
      throw new PluginRpcError(
        RPC_ERRORS.unsupported,
        "Raw terminal interceptor providers require the privileged PR 6 transport",
      );
    }
    throw invalidArgument("Terminal Provider kind is invalid");
  }
  return kind;
}

function normalizeDeadlineMs(value) {
  const deadlineMs = value ?? DEFAULT_PROVIDER_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    throw invalidArgument("Terminal Provider deadline is invalid");
  }
  return deadlineMs;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new PluginRpcError(RPC_ERRORS.cancelled, "Terminal Provider request was cancelled");
  }
}

function optionalString(value, label, maximum = 512) {
  if (value == null) return undefined;
  return assertBoundedString(value, label, maximum);
}

function normalizeTerminalProtocol(value) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw invalidArgument("Terminal session protocol is invalid");
  }
  return value;
}

function normalizeTerminalSessionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument("Terminal session snapshot must be an object");
  }
  const protocol = normalizeTerminalProtocol(value.protocol);
  const status = value.status;
  if (!TERMINAL_STATUSES.has(status)) throw invalidArgument("Terminal session status is invalid");
  if (value.shellType != null && !TERMINAL_SHELL_TYPES.has(value.shellType)) {
    throw invalidArgument("Terminal session shell type is invalid");
  }
  if (value.alternateScreen != null && typeof value.alternateScreen !== "boolean") {
    throw invalidArgument("Terminal alternate-screen state is invalid");
  }
  const normalizeDimension = (dimension, label) => {
    if (dimension == null) return undefined;
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 16_384) {
      throw invalidArgument(`Terminal session ${label} is invalid`);
    }
    return dimension;
  };
  return freezeJson({
    sessionId: assertBoundedString(value.sessionId, "Terminal session ID"),
    ...(value.hostId == null ? {} : { hostId: optionalString(value.hostId, "Terminal host ID") }),
    ...(value.workspaceId == null ? {} : { workspaceId: optionalString(value.workspaceId, "Terminal workspace ID") }),
    protocol,
    status,
    ...(value.cwd == null ? {} : { cwd: optionalString(value.cwd, "Terminal working directory", 4_096) }),
    ...(value.title == null ? {} : { title: optionalString(value.title, "Terminal title", 1_024) }),
    ...(value.shellType == null ? {} : { shellType: value.shellType }),
    ...(value.cols == null ? {} : { cols: normalizeDimension(value.cols, "column count") }),
    ...(value.rows == null ? {} : { rows: normalizeDimension(value.rows, "row count") }),
    ...(value.alternateScreen == null ? {} : { alternateScreen: value.alternateScreen === true }),
  });
}

function normalizeTerminalSessionEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !TERMINAL_EVENT_TYPES.has(value.type)) {
    throw invalidArgument("Terminal session event is invalid");
  }
  const event = {
    type: value.type,
    session: normalizeTerminalSessionSnapshot(value.session),
    ...(value.exitCode == null ? {} : { exitCode: value.exitCode }),
  };
  if (event.exitCode != null && !Number.isSafeInteger(event.exitCode)) {
    throw invalidArgument("Terminal session exit code is invalid");
  }
  // PR 5 lifecycle events intentionally exclude command text and raw output.
  // Sensitive input/output interception belongs to the privileged PR 6 path.
  assertBoundedJson(event, "Terminal session event");
  return freezeJson(event);
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertVisibleString(value, label, maximum) {
  assertBoundedString(value, label, maximum);
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)) {
      throw new TypeError(`${label} contains unsafe control characters`);
    }
  }
  return value;
}

function assertProviderTextRanges(value, options) {
  const result = assertPlainRecord(value, `${options.label} result`);
  const items = result[options.property];
  if (!Array.isArray(items) || items.length > 64) {
    throw new TypeError(`${options.label} result is invalid`);
  }
  const line = options.payload?.line;
  if (typeof line !== "string" || line.length > 8_192) {
    throw new TypeError(`${options.label} payload line is invalid`);
  }
  for (const candidate of items) {
    const item = assertPlainRecord(candidate, `${options.label} item`);
    if (!Number.isInteger(item.start)
      || !Number.isInteger(item.length)
      || item.start < 0
      || item.length < 1
      || item.start > line.length
      || item.length > line.length - item.start) {
      throw new TypeError(`${options.label} range is invalid`);
    }
    options.assertItem(item);
  }
}

function assertOptionalColor(value, label) {
  if (value == null) return;
  const color = assertVisibleString(value, label, 9);
  if (!/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(color)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertAnnotations(value, label) {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError(`${label} is invalid`);
  for (const candidate of value) {
    const annotation = assertPlainRecord(candidate, `${label} item`);
    assertVisibleString(annotation.text, `${label} text`, 512);
    assertOptionalColor(annotation.color, `${label} color`);
  }
}

function assertMatcherLines(payload) {
  if (!Array.isArray(payload?.lines) || payload.lines.length < 1 || payload.lines.length > 32) {
    throw new TypeError("Terminal matcher payload lines are invalid");
  }
  const lines = new Map();
  let characterCount = 0;
  for (const candidate of payload.lines) {
    const item = assertPlainRecord(candidate, "Terminal matcher payload line");
    const lineId = assertVisibleString(item.lineId, "Terminal matcher line ID", 64);
    const line = assertVisibleString(item.line, "Terminal matcher line", 8_192);
    characterCount += line.length;
    if (characterCount > 96 * 1024) {
      throw new TypeError("Terminal matcher payload exceeds its line budget");
    }
    if (lines.has(lineId)) throw new TypeError("Terminal matcher line IDs must be unique");
    if (!Number.isInteger(item.bufferLineNumber) || item.bufferLineNumber < 1) {
      throw new TypeError("Terminal matcher buffer line number is invalid");
    }
    lines.set(lineId, line);
  }
  return lines;
}

function assertCompletionResult(value) {
  const result = assertPlainRecord(value, "Terminal completion result");
  if (!Array.isArray(result.items) || result.items.length > 100) {
    throw new TypeError("Terminal completion items are invalid");
  }
  for (const candidate of result.items) {
    const item = assertPlainRecord(candidate, "Terminal completion item");
    const text = assertVisibleString(item.text, "Terminal completion text", 4_096);
    if (item.displayText != null
      && assertVisibleString(item.displayText, "Terminal completion display text", 4_096) !== text) {
      throw new TypeError("Terminal completion display text must match the inserted text");
    }
    if (item.description != null) {
      assertVisibleString(item.description, "Terminal completion description", 2_048);
    }
    if (item.score != null && (typeof item.score !== "number" || !Number.isFinite(item.score))) {
      throw new TypeError("Terminal completion score is invalid");
    }
  }
}

function assertDecorationResult(value) {
  const result = assertPlainRecord(value, "Terminal decoration result");
  if (!Array.isArray(result.rules) || result.rules.length > 64) {
    throw new TypeError("Terminal decoration rules are invalid");
  }
  for (const candidate of result.rules) {
    const rule = assertPlainRecord(candidate, "Terminal decoration rule");
    assertVisibleString(rule.id, "Terminal decoration rule ID", 128);
    assertVisibleString(rule.label, "Terminal decoration rule label", 256);
    if (!Array.isArray(rule.patterns) || rule.patterns.length < 1 || rule.patterns.length > 16) {
      throw new TypeError("Terminal decoration rule patterns are invalid");
    }
    for (const pattern of rule.patterns) {
      assertVisibleString(pattern, "Terminal decoration pattern", 512);
    }
    if (typeof rule.color !== "string") {
      throw new TypeError("Terminal decoration rule color is required");
    }
    assertOptionalColor(rule.color, "Terminal decoration rule color");
  }
}

function assertTerminalProviderPayload(kind, operation, payload) {
  if (TERMINAL_PROVIDER_OPERATIONS.get(kind) !== operation) {
    throw new TypeError("Terminal Provider operation does not match its kind");
  }
  if (kind === "terminal.completion") {
    const input = assertVisibleString(payload?.input, "Terminal completion input", 4_096);
    if (!Number.isInteger(payload.cursor) || payload.cursor < 0 || payload.cursor > input.length) {
      throw new TypeError("Terminal completion cursor is invalid");
    }
    if (!["linux", "windows", "macos"].includes(payload.hostOs)) {
      throw new TypeError("Terminal completion host OS is invalid");
    }
    if (payload.cwdSource != null && !["prompt", "fallback", "none"].includes(payload.cwdSource)) {
      throw new TypeError("Terminal completion CWD source is invalid");
    }
    if (!Number.isInteger(payload.maximum) || payload.maximum < 1 || payload.maximum > 100) {
      throw new TypeError("Terminal completion maximum is invalid");
    }
  }
  if (kind === "terminal.decoration") {
    assertVisibleString(payload?.reason, "Terminal decoration reason", 128);
  }
  if (kind === "terminal.link" || kind === "terminal.hover") {
    assertVisibleString(payload?.line, "Terminal Provider line", 8_192);
    if (!Number.isInteger(payload.bufferLineNumber) || payload.bufferLineNumber < 1) {
      throw new TypeError("Terminal Provider buffer line number is invalid");
    }
  }
  if (kind === "terminal.matcher") assertMatcherLines(payload);
  if (kind === "terminal.semantic") {
    assertVisibleString(payload?.command, "Terminal semantic command", 4_096);
  }
  if (kind === "terminal.prompt") {
    if (payload?.reason !== "commandCompleted") throw new TypeError("Terminal prompt reason is invalid");
    if (payload.promptLine != null) {
      assertVisibleString(payload.promptLine, "Terminal prompt line", 8_192);
      if (!Number.isInteger(payload.bufferLineNumber) || payload.bufferLineNumber < 1) {
        throw new TypeError("Terminal prompt buffer line number is invalid");
      }
    } else if (payload.bufferLineNumber != null) {
      throw new TypeError("Terminal prompt line number requires a prompt line");
    }
  }
  if (kind === "terminal.background") {
    assertVisibleString(payload?.reason, "Terminal background reason", 128);
    assertOptionalColor(payload.terminalBackground, "Terminal background color");
  }
  if (kind === "terminal.theme") {
    assertVisibleString(payload?.reason, "Terminal theme reason", 128);
    const currentTheme = assertPlainRecord(payload?.currentTheme, "Current terminal theme");
    if (currentTheme.type !== "dark" && currentTheme.type !== "light") {
      throw new TypeError("Current terminal theme type is invalid");
    }
    const colors = assertPlainRecord(currentTheme.colors, "Current terminal theme colors");
    for (const key of TERMINAL_THEME_COLOR_KEYS) {
      if (typeof colors[key] !== "string") throw new TypeError(`Current terminal theme ${key} is required`);
      assertOptionalColor(colors[key], `Current terminal theme ${key}`);
    }
    if (Object.keys(colors).some((key) => !TERMINAL_THEME_COLOR_KEY_SET.has(key))) {
      throw new TypeError("Current terminal theme contains an unknown color");
    }
  }
}

function assertTerminalProviderOkResult(kind, value, payload) {
  if (kind === "terminal.completion") assertCompletionResult(value);
  if (kind === "terminal.decoration") assertDecorationResult(value);
  if (kind === "terminal.link") {
    assertProviderTextRanges(value, {
      label: "Terminal link",
      property: "links",
      payload,
      assertItem(item) {
        const uri = assertVisibleString(item.uri, "Terminal link URI", 2_048);
        const parsed = new URL(uri);
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
          || parsed.username || parsed.password) {
          throw new TypeError("Terminal link URI is invalid");
        }
        if (item.label != null) assertVisibleString(item.label, "Terminal link label", 256);
      },
    });
  }
  if (kind === "terminal.hover") {
    assertProviderTextRanges(value, {
      label: "Terminal hover",
      property: "hovers",
      payload,
      assertItem(item) {
        assertVisibleString(item.contents, "Terminal hover contents", 2_048);
      },
    });
  }
  if (kind === "terminal.matcher") {
    const result = assertPlainRecord(value, "Terminal matcher result");
    const lines = assertMatcherLines(payload);
    if (!Array.isArray(result.matches) || result.matches.length > 64) {
      throw new TypeError("Terminal matcher result is invalid");
    }
    for (const candidate of result.matches) {
      const item = assertPlainRecord(candidate, "Terminal matcher item");
      const lineId = assertVisibleString(item.lineId, "Terminal matcher line ID", 64);
      const line = lines.get(lineId);
      if (line === undefined
        || !Number.isInteger(item.start)
        || !Number.isInteger(item.length)
        || item.start < 0
        || item.length < 1
        || item.start > line.length
        || item.length > line.length - item.start) {
        throw new TypeError("Terminal matcher range is invalid");
      }
      assertVisibleString(item.label, "Terminal matcher label", 256);
      if (item.severity != null && !["info", "warning", "error", "success"].includes(item.severity)) {
        throw new TypeError("Terminal matcher severity is invalid");
      }
      assertOptionalColor(item.color, "Terminal matcher color");
    }
  }
  if (kind === "terminal.semantic") {
    const result = assertPlainRecord(value, "Terminal semantic result");
    const command = payload?.command;
    assertVisibleString(command, "Terminal semantic command", 4_096);
    if (result.classification != null) {
      assertVisibleString(result.classification, "Terminal semantic classification", 128);
    }
    if (result.description != null) {
      assertVisibleString(result.description, "Terminal semantic description", 1_024);
    }
    if (result.destructive != null && typeof result.destructive !== "boolean") {
      throw new TypeError("Terminal semantic destructive flag is invalid");
    }
    if (result.idempotent != null && typeof result.idempotent !== "boolean") {
      throw new TypeError("Terminal semantic idempotent flag is invalid");
    }
    if (result.annotations != null) assertAnnotations(result.annotations, "Terminal semantic annotations");
  }
  if (kind === "terminal.prompt") {
    const result = assertPlainRecord(value, "Terminal prompt result");
    if (payload?.promptLine != null) {
      assertVisibleString(payload.promptLine, "Terminal prompt line", 8_192);
      if (!Number.isInteger(payload.bufferLineNumber) || payload.bufferLineNumber < 1) {
        throw new TypeError("Terminal prompt buffer line number is invalid");
      }
    }
    assertAnnotations(result.annotations, "Terminal prompt annotations");
  }
  if (kind === "terminal.background") {
    const result = assertPlainRecord(value, "Terminal background result");
    if (result.refreshAfterMs != null
      && (!Number.isInteger(result.refreshAfterMs)
        || result.refreshAfterMs < 250
        || result.refreshAfterMs > 60_000)) {
      throw new TypeError("Terminal background refresh cadence is invalid");
    }
    if (!Array.isArray(result.layers) || result.layers.length > 4) {
      throw new TypeError("Terminal background layers are invalid");
    }
    for (const candidate of result.layers) {
      const layer = assertPlainRecord(candidate, "Terminal background layer");
      assertVisibleString(layer.id, "Terminal background layer ID", 128);
      if (typeof layer.color !== "string") {
        throw new TypeError("Terminal background layer color is required");
      }
      assertOptionalColor(layer.color, "Terminal background layer color");
      if (layer.opacity != null
        && (typeof layer.opacity !== "number"
          || !Number.isFinite(layer.opacity)
          || layer.opacity < 0
          || layer.opacity > 0.35)) {
        throw new TypeError("Terminal background layer opacity is invalid");
      }
    }
  }
  if (kind === "terminal.theme") {
    const result = assertPlainRecord(value, "Terminal theme result");
    const colors = assertPlainRecord(result.colors, "Terminal theme colors");
    if (Object.keys(result).some((key) => key !== "colors")
      || Object.keys(colors).some((key) => !TERMINAL_THEME_COLOR_KEY_SET.has(key))) {
      throw new TypeError("Terminal theme result contains an unknown property");
    }
    for (const [key, color] of Object.entries(colors)) {
      assertOptionalColor(color, `Terminal theme ${key}`);
    }
  }
}

function providerFailure(requestId, error) {
  if (error instanceof PluginRpcError && error.code === RPC_ERRORS.cancelled) {
    return Object.freeze({ requestId, status: "cancelled" });
  }
  return freezeJson({
    requestId,
    status: "failed",
    error: {
      code: error instanceof PluginRpcError ? error.code : RPC_ERRORS.internal,
      message: String(error?.message ?? "Plugin Provider failed").slice(0, 2_048) || "Plugin Provider failed",
    },
  });
}

function normalizeActivationIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || typeof identity.pluginId !== "string"
    || identity.pluginId !== activation.plugin.id
    || typeof identity.pluginVersion !== "string"
    || identity.pluginVersion !== activation.plugin.activeVersion
    || typeof identity.runtimeId !== "string"
    || identity.runtimeId.length < 1
    || typeof identity.runtimeKind !== "string"
    || identity.runtimeKind.length < 1
    || typeof identity.securityPrincipal !== "string"
    || identity.securityPrincipal.length < 1) {
    throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin Provider activation identity is unavailable or stale");
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

function runtimeIdentityMatches(current, expected) {
  return current?.pluginId === expected.pluginId
    && current?.pluginVersion === expected.pluginVersion
    && current?.runtimeId === expected.runtimeId
    && current?.runtimeKind === expected.runtimeKind
    && current?.securityPrincipal === expected.securityPrincipal;
}

class PluginTerminalProviderService {
  constructor(options) {
    if (!options?.contributionService || !options?.runtimeSupervisor || !options?.permissionEngine) {
      throw new TypeError("Terminal Provider service requires contribution, runtime, and permission services");
    }
    this.contributionService = options.contributionService;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.permissionEngine = options.permissionEngine;
    this.lifecycleAuthorizations = new Map();
    this.contributionService.onDidChange?.(() => {
      this.pruneLifecycleAuthorizations(this.activeTerminalProviderPluginIds());
    });
  }

  lifecycleAuthorizationKey(pluginId, sessionId) {
    return `${pluginId}\0${sessionId}`;
  }

  activeTerminalProviderPluginIds() {
    const pluginIds = new Set();
    for (const entry of this.contributionService.listProviders()) {
      if (TERMINAL_PROVIDER_KIND_SET.has(entry.provider.kind)) pluginIds.add(entry.pluginId);
    }
    return pluginIds;
  }

  pruneLifecycleAuthorizations(pluginIds, sessionId = null) {
    for (const [key, authorization] of this.lifecycleAuthorizations) {
      if ((sessionId == null || authorization.sessionId === sessionId)
        && !pluginIds.has(authorization.identity.pluginId)) {
        this.lifecycleAuthorizations.delete(key);
      }
    }
  }

  rememberLifecycleAuthorization(activation, identity, sessionId) {
    this.lifecycleAuthorizations.set(
      this.lifecycleAuthorizationKey(activation.plugin.id, sessionId),
      Object.freeze({
        context: Object.freeze({
          pluginId: activation.plugin.id,
          pluginVersion: activation.plugin.activeVersion,
          runtimeId: identity.runtimeId,
          runtimeKind: identity.runtimeKind,
          manifest: activation.plugin.manifest,
          securityPrincipal: identity.securityPrincipal,
        }),
        identity,
        sessionId,
      }),
    );
  }

  listProviders(options = {}) {
    const kind = assertTerminalProviderKind(options.kind);
    const preferredProviderIds = options.preferredProviderIds ?? [];
    if (!Array.isArray(preferredProviderIds)
      || preferredProviderIds.length > 256
      || preferredProviderIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 256)
      || new Set(preferredProviderIds).size !== preferredProviderIds.length) {
      throw invalidArgument("Preferred Terminal Provider IDs are invalid");
    }
    if (options.locale != null
      && (typeof options.locale !== "string" || options.locale.length < 1 || options.locale.length > 128)) {
      throw invalidArgument("Terminal Provider locale is invalid");
    }
    const preferred = new Map(preferredProviderIds.map((id, index) => [id, index]));
    const providers = [...this.contributionService.listProviders({ kind, locale: options.locale })];
    providers.sort((left, right) => {
      const leftRank = preferred.get(left.provider.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = preferred.get(right.provider.id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank
        || left.pluginId.localeCompare(right.pluginId)
        || left.provider.id.localeCompare(right.provider.id);
    });
    return freezeJson(providers);
  }

  async invokeProvider(params, options = {}) {
    const kind = assertTerminalProviderKind(params?.kind);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const request = {
      providerId: params?.providerId,
      operation: params?.operation,
      requestId: params?.requestId ?? `provider-${randomUUID()}`,
      ...(params?.payload === undefined ? {} : { payload: assertBoundedJson(params.payload, "Provider payload") }),
      deadlineMs,
    };
    try { assertProviderRequest(request); }
    catch (error) { throw invalidArgument(error?.message ?? "Provider request is invalid"); }
    throwIfCancelled(options.signal);
    const activationOperation = Promise.resolve(
      this.contributionService.activateProvider(request.providerId),
    );
    const activation = options.signal
      ? await raceWithAbort(activationOperation, options.signal)
      : await activationOperation;
    throwIfCancelled(options.signal);
    if (activation.provider.kind !== kind) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Plugin Provider kind changed during activation");
    }
    const identity = normalizeActivationIdentity(activation);
    const invocationSession = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
      ? request.payload.session
      : null;
    const permissionSession = invocationSession == null
      ? null
      : normalizeTerminalSessionSnapshot(invocationSession);
    let providerPermissionScope;
    for (const permission of TERMINAL_PROVIDER_PERMISSIONS.get(kind) ?? []) {
      const grant = await this.permissionEngine.authorize({
        pluginId: activation.plugin.id,
        pluginVersion: activation.plugin.activeVersion,
        runtimeId: identity.runtimeId,
        runtimeKind: identity.runtimeKind,
        manifest: activation.plugin.manifest,
        securityPrincipal: identity.securityPrincipal,
        signal: options.signal,
      }, {
        permission,
        resources: ["*"],
        reason: `Use ${activation.provider.id} for ${kind}`,
        operationId: `${kind}:${activation.provider.id}`,
        ...(permissionSession == null ? {} : { sessionId: permissionSession.sessionId }),
      });
      if (permission === "provider.terminal") providerPermissionScope = grant?.scope;
    }
    const expectedIdentity = { expectedIdentity: identity };
    if (permissionSession != null) {
      await this.runtimeSupervisor.notify(activation.plugin.id, "plugin.terminal.event", {
        type: "snapshot",
        session: permissionSession,
      }, expectedIdentity);
    }
    const rawResult = await this.runtimeSupervisor.request(activation.plugin.id, "provider.invoke", {
      ...request,
      kind,
    }, {
      signal: options.signal,
      timeoutMs: deadlineMs,
      ...expectedIdentity,
    });
    let result;
    try {
      assertProviderResult(rawResult);
      assertBoundedJson(rawResult, "Provider result");
      if (rawResult.status === "ok") {
        assertTerminalProviderOkResult(kind, rawResult.result, request.payload);
      }
      result = rawResult;
    } catch (error) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, `Plugin Provider returned an invalid result: ${error?.message ?? error}`);
    }
    if (result.requestId !== request.requestId) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin Provider returned a mismatched request ID");
    }
    if (result.status === "ok" && permissionSession != null && providerPermissionScope !== "once") {
      this.rememberLifecycleAuthorization(activation, identity, permissionSession.sessionId);
    }
    return freezeJson({
      pluginId: activation.plugin.id,
      pluginVersion: activation.plugin.activeVersion,
      runtimeId: identity.runtimeId,
      providerId: activation.provider.id,
      kind,
      ...result,
    });
  }

  async provide(params, options = {}) {
    const kind = assertTerminalProviderKind(params?.kind);
    const operation = assertBoundedString(params?.operation, "Terminal Provider operation", 128);
    const session = normalizeTerminalSessionSnapshot(params?.session);
    const providedPayload = params?.payload === undefined
      ? undefined
      : assertBoundedJson(params.payload, "Provider payload");
    const payload = freezeJson(providedPayload && typeof providedPayload === "object" && !Array.isArray(providedPayload)
      ? { ...providedPayload, session }
      : { session, ...(providedPayload === undefined ? {} : { value: providedPayload }) });
    assertBoundedJson(payload, "Provider request payload");
    try { assertTerminalProviderPayload(kind, operation, payload); }
    catch (error) { throw invalidArgument(error?.message ?? "Terminal Provider payload is invalid"); }
    const providers = this.listProviders({
      kind,
      locale: params?.locale,
      preferredProviderIds: params?.preferredProviderIds,
    }).slice(0, MAX_TERMINAL_PROVIDERS_PER_REQUEST);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    return freezeJson(await Promise.all(providers.map(async (entry) => {
      const { provider } = entry;
      const requestId = `provider-${randomUUID()}`;
      try {
        return await this.invokeProvider({
          providerId: provider.id,
          kind,
          operation,
          requestId,
          payload,
          deadlineMs,
        }, options);
      } catch (error) {
        return freezeJson({
          pluginId: entry.pluginId,
          pluginVersion: entry.pluginVersion,
          providerId: provider.id,
          kind,
          ...providerFailure(requestId, options.signal?.aborted
            ? new PluginRpcError(RPC_ERRORS.cancelled, "Terminal Provider request was cancelled")
            : error),
        });
      }
    })));
  }

  async publishSessionEvent(event) {
    const normalized = normalizeTerminalSessionEvent(event);
    const sessionId = normalized.session.sessionId;
    const pluginIds = this.activeTerminalProviderPluginIds();
    this.pruneLifecycleAuthorizations(pluginIds, sessionId);
    const deliveries = await Promise.all([...pluginIds].sort().map(async (pluginId) => {
      const key = this.lifecycleAuthorizationKey(pluginId, sessionId);
      const authorization = this.lifecycleAuthorizations.get(key);
      if (!authorization) return Object.freeze({ pluginId, delivered: false });
      const identity = this.runtimeSupervisor.getRuntimeIdentity(pluginId);
      if (!runtimeIdentityMatches(identity, authorization.identity)) {
        this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: false });
      }
      try {
        await this.permissionEngine.authorize(authorization.context, {
          permission: "provider.terminal",
          resources: ["*"],
          reason: "Receive Terminal Provider lifecycle metadata",
          operationId: `terminal.lifecycle:${sessionId}`,
          sessionId,
          interactive: false,
        });
        await this.runtimeSupervisor.notify(pluginId, "plugin.terminal.event", normalized, {
          expectedIdentity: authorization.identity,
        });
        if (normalized.type === "disposed") this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: true });
      } catch {
        this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: false });
      }
    }));
    if (normalized.type === "disposed") {
      for (const [key, authorization] of this.lifecycleAuthorizations) {
        if (authorization.sessionId === sessionId) this.lifecycleAuthorizations.delete(key);
      }
    }
    return freezeJson(deliveries);
  }
}

module.exports = {
  DEFAULT_PROVIDER_DEADLINE_MS,
  MAX_PROVIDER_JSON_BYTES,
  MAX_TERMINAL_PROVIDERS_PER_REQUEST,
  PluginTerminalProviderService,
  TERMINAL_PROVIDER_KINDS,
  TERMINAL_PROVIDER_PERMISSIONS,
  assertTerminalProviderKind,
  normalizeTerminalSessionEvent,
  normalizeTerminalSessionSnapshot,
};
