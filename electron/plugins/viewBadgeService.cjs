"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { invalidArgument, freezeJson } = require("./validationUtils.cjs");

const ALLOWED_BADGE_LOCATIONS = new Set(["vault-page", "terminal-sidebar"]);
const ALLOWED_BADGE_TONES = new Set(["default", "info", "warning", "danger"]);
const ALLOWED_PARAM_KEYS = new Set(["viewId", "count", "text", "dot", "tone", "tooltip"]);
const MAX_BADGE_COUNT = 999;
const MAX_BADGE_TEXT_LENGTH = 4;
const MAX_BADGE_TOOLTIP_LENGTH = 160;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const PRINTABLE_ASCII_RE = /^[\u0020-\u007e]*$/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertOwnedBadgeView(manifest, viewId, pluginId) {
  if (typeof viewId !== "string" || !viewId.startsWith(`${pluginId}.`) || viewId.length > 256) {
    throw invalidArgument("Plugin view ID is invalid or belongs to another plugin");
  }
  const view = manifest?.contributes?.views?.find((item) => item?.id === viewId) ?? null;
  if (!view) {
    throw new PluginRpcError(RPC_ERRORS.notFound, `Plugin view contribution was not found: ${viewId}`);
  }
  if (!ALLOWED_BADGE_LOCATIONS.has(view.location)) {
    throw invalidArgument(`Plugin view badges are only supported on vault-page and terminal-sidebar views: ${viewId}`);
  }
  return view;
}

function normalizeViewBadgeParams(params, context) {
  if (!isPlainObject(params)) {
    throw invalidArgument("Plugin view badge parameters must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAM_KEYS.has(key)) {
      throw invalidArgument(`Unknown plugin view badge parameter: ${key}`);
    }
  }
  const view = assertOwnedBadgeView(context.manifest, params.viewId, context.pluginId);

  let count;
  if (params.count !== undefined && params.count !== null) {
    if (typeof params.count !== "number" || !Number.isSafeInteger(params.count) || params.count < 0) {
      throw invalidArgument("Plugin view badge count must be a non-negative integer or null");
    }
    const clamped = Math.min(MAX_BADGE_COUNT, params.count);
    if (clamped > 0) count = clamped;
  }

  let text;
  if (params.text !== undefined && params.text !== null) {
    if (typeof params.text !== "string") {
      throw invalidArgument("Plugin view badge text must be a string or null");
    }
    if (CONTROL_CHAR_RE.test(params.text)) {
      throw invalidArgument("Plugin view badge text must not contain control characters");
    }
    const trimmed = params.text.trim();
    if (trimmed.length > MAX_BADGE_TEXT_LENGTH || !PRINTABLE_ASCII_RE.test(trimmed)) {
      throw invalidArgument("Plugin view badge text must be at most 4 printable ASCII characters");
    }
    if (trimmed.length > 0) text = trimmed;
  }

  let dot = false;
  if (params.dot !== undefined) {
    if (typeof params.dot !== "boolean") {
      throw invalidArgument("Plugin view badge dot must be a boolean");
    }
    dot = params.dot;
  }

  let tone = "default";
  if (params.tone !== undefined) {
    if (typeof params.tone !== "string" || !ALLOWED_BADGE_TONES.has(params.tone)) {
      throw invalidArgument("Plugin view badge tone must be default, info, warning, or danger");
    }
    tone = params.tone;
  }

  let tooltip;
  if (params.tooltip !== undefined && params.tooltip !== null) {
    if (typeof params.tooltip !== "string") {
      throw invalidArgument("Plugin view badge tooltip must be a string or null");
    }
    if (CONTROL_CHAR_RE.test(params.tooltip)) {
      throw invalidArgument("Plugin view badge tooltip must not contain control characters");
    }
    const trimmed = params.tooltip.trim();
    if (trimmed.length > MAX_BADGE_TOOLTIP_LENGTH) {
      throw invalidArgument("Plugin view badge tooltip must be at most 160 characters");
    }
    if (trimmed.length > 0) tooltip = trimmed;
  }

  // Precedence: count (1..999) > text (1..4 ASCII) > dot (true). Absent all -> clear.
  let badge = null;
  if (count !== undefined) {
    badge = {
      pluginId: context.pluginId,
      viewId: view.id,
      count,
      tone,
      ...(tooltip !== undefined ? { tooltip } : {}),
    };
  } else if (text !== undefined) {
    badge = {
      pluginId: context.pluginId,
      viewId: view.id,
      text,
      tone,
      ...(tooltip !== undefined ? { tooltip } : {}),
    };
  } else if (dot) {
    badge = {
      pluginId: context.pluginId,
      viewId: view.id,
      dot: true,
      tone,
      ...(tooltip !== undefined ? { tooltip } : {}),
    };
  }

  return { viewId: view.id, badge };
}

function badgesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.pluginId === right.pluginId
    && left.viewId === right.viewId
    && left.count === right.count
    && left.text === right.text
    && left.dot === right.dot
    && left.tone === right.tone
    && left.tooltip === right.tooltip;
}

class PluginViewBadgeService {
  constructor(options = {}) {
    this.isLocked = options.isLocked ?? (() => false);
    this.clock = options.clock ?? (() => Date.now());
    this.entries = new Map();
    this.listeners = new Set();
    this.changeSubscription = options.contributionService?.onDidChange?.((event) => {
      if (
        ["plugin-disabled", "runtime-stopped", "runtime-error", "runtime-quarantined"].includes(event?.reason)
        && typeof event.pluginId === "string"
      ) {
        this.clearPlugin(event.pluginId);
      }
    }) ?? null;
    this.unsubscribeLock = options.subscribeLock?.((state) => {
      if (state?.locked) this.clearAll();
    }) ?? null;
  }

  registerRpcCapabilities(registry) {
    registry.registerRequest("views.setBadge", (params, context) => this.setBadge(params, context), {
      metadata: { capability: "views", mutating: true, permission: "views" },
      authorization: { permission: "views", resources: ["*"], reason: "Display a notification badge on a plugin view" },
    });
  }

  setBadge(params, context) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    const { viewId, badge } = normalizeViewBadgeParams(params, context);
    const key = `${context.pluginId}\0${viewId}`;
    const existing = this.entries.get(key) ?? null;

    if (!badge) {
      if (!existing) return null;
      this.entries.delete(key);
      this.#emit();
      return null;
    }

    if (existing && existing.runtimeId === (context.runtimeId ?? null) && badgesEqual(existing.badge, badge)) {
      return null;
    }

    const stored = freezeJson({
      ...badge,
      updatedAt: this.clock(),
    });
    this.entries.set(key, {
      pluginId: context.pluginId,
      runtimeId: context.runtimeId ?? null,
      badge: stored,
    });
    this.#emit();
    return null;
  }

  listBadges() {
    if (this.isLocked()) return Object.freeze([]);
    const list = [...this.entries.values()]
      .map((entry) => entry.badge)
      .sort((a, b) => a.viewId.localeCompare(b.viewId));
    return Object.freeze(list);
  }

  onDidChange(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Plugin view badge listener must be a function");
    }
    this.listeners.add(listener);
    return Object.freeze({ dispose: () => this.listeners.delete(listener) });
  }

  releaseRuntime(runtimeId) {
    if (typeof runtimeId !== "string" || !runtimeId) return false;
    let changed = false;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.runtimeId === runtimeId) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.#emit();
    return changed;
  }

  clearPlugin(pluginId) {
    if (typeof pluginId !== "string" || !pluginId) return false;
    let changed = false;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.pluginId === pluginId) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.#emit();
    return changed;
  }

  clearAll() {
    if (this.entries.size === 0) return false;
    this.entries.clear();
    this.#emit();
    return true;
  }

  shutdown() {
    this.changeSubscription?.dispose?.();
    this.changeSubscription = null;
    this.unsubscribeLock?.();
    this.unsubscribeLock = null;
    this.entries.clear();
    this.listeners.clear();
  }

  #emit() {
    const snapshot = this.listBadges();
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); } catch {}
    }
  }
}

module.exports = {
  ALLOWED_BADGE_LOCATIONS,
  ALLOWED_BADGE_TONES,
  MAX_BADGE_COUNT,
  MAX_BADGE_TEXT_LENGTH,
  MAX_BADGE_TOOLTIP_LENGTH,
  PluginViewBadgeService,
  normalizeViewBadgeParams,
};
