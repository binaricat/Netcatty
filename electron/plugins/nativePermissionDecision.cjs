"use strict";

const MAX_VISIBLE_RESOURCES = 20;
const MAX_VISIBLE_FIELD_LENGTH = 1_024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

function escapePermissionText(value, maxLength = MAX_VISIBLE_FIELD_LENGTH) {
  const text = String(value).slice(0, maxLength);
  return text.replace(UNSAFE_DISPLAY_CHARACTERS, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`;
  });
}

function describePermissionRequest(request) {
  const identity = request.pluginName
    ? `${escapePermissionText(request.pluginName)} (${escapePermissionText(request.pluginId)})`
    : escapePermissionText(request.pluginId);
  const resources = request.resources ?? [];
  const resourceKinds = request.resourceKinds ?? [];
  const visibleResources = resources.slice(0, MAX_VISIBLE_RESOURCES).map((resource, index) => {
    const suffix = resourceKinds[index] === "directory" ? " (directory and descendants)" : "";
    return `- ${escapePermissionText(resource)}${suffix}`;
  });
  if (resources.length > visibleResources.length) {
    visibleResources.push(`- …and ${resources.length - visibleResources.length} more`);
  }
  return [
    `Plugin: ${identity}`,
    ...(request.publisher ? [`Publisher: ${escapePermissionText(request.publisher)}`] : []),
    `Permission: ${escapePermissionText(request.permission)}`,
    `Reason: ${escapePermissionText(request.reason)}`,
    ...(visibleResources.length ? ["Resources:", ...visibleResources] : []),
  ].join("\n");
}

function createNativePermissionDecisionProvider(options) {
  if (!options?.dialog || typeof options.dialog.showMessageBox !== "function") {
    throw new TypeError("Native plugin permission decisions require an Electron dialog");
  }
  const dialog = options.dialog;
  const window = options.window;
  return async (request, context = {}) => {
    context.signal?.throwIfAborted();
    const allowedScopes = Array.isArray(request.allowedScopes)
      ? new Set(request.allowedScopes)
      : null;
    const supportsScope = (scope) => allowedScopes == null || allowedScopes.has(scope);
    const choices = [
      { label: "Deny", decision: "deny" },
      ...(supportsScope("once") ? [{ label: "Allow Once", decision: "allow", scope: "once" }] : []),
      ...(request.sessionId && supportsScope("session")
        ? [{ label: "Allow for Session", decision: "allow", scope: "session" }]
        : []),
      ...(supportsScope("application")
        ? [{ label: "Allow for Application", decision: "allow", scope: "application" }]
        : []),
      ...(supportsScope("always")
        ? [{ label: "Always Allow", decision: "allow", scope: "always" }]
        : []),
    ];
    const messageBoxOptions = {
      type: "warning",
      title: "Plugin permission request",
      message: `${escapePermissionText(request.pluginName ?? request.pluginId)} requests ${escapePermissionText(request.permission)}`,
      detail: describePermissionRequest(request),
      buttons: choices.map(({ label }) => label),
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(context.signal ? { signal: context.signal } : {}),
    };
    const result = window
      ? await dialog.showMessageBox(window, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);
    context.signal?.throwIfAborted();
    const choice = choices[result.response] ?? choices[0];
    if (choice.decision !== "allow") {
      return Object.freeze({ requestId: request.requestId, decision: "deny" });
    }
    return Object.freeze({
      requestId: request.requestId,
      decision: "allow",
      scope: choice.scope,
    });
  };
}

module.exports = {
  MAX_VISIBLE_FIELD_LENGTH,
  MAX_VISIBLE_RESOURCES,
  createNativePermissionDecisionProvider,
  describePermissionRequest,
  escapePermissionText,
};
