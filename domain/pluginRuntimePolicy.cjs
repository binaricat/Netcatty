"use strict";

// Shared by host placement, release admission, and the installed-package UI.
// A Node entrypoint does not change default placement, but is not admitted to
// the normal browser-only product path.
function isStaticThemePack(manifest) {
  return manifest?.main?.data === "theme" && Object.keys(manifest.main).length === 1
    && Array.isArray(manifest.contributes?.themes) && manifest.contributes.themes.length > 0
    && Object.keys(manifest.contributes).every((key) => key === "themes")
    && !Object.keys(manifest.permissions ?? {}).length && !manifest.activationEvents?.length
    && !manifest.companionExecutables?.length
    && manifest.features?.required?.includes("appearance.theme-packs");
}
function describePluginRuntime(manifest) {
  const providers = manifest?.contributes?.providers ?? [];
  const permissions = [...(manifest?.permissions?.required ?? []), ...(manifest?.permissions?.optional ?? [])];
  const permissionIds = permissions.map((entry) => typeof entry === "string" ? entry : entry.permission);
  const hasCompanions = Boolean(manifest?.companionExecutables?.length);
  const hasInterceptors = providers.some((provider) => (
    provider.kind === "terminal.interceptor.input" || provider.kind === "terminal.interceptor.output"
  ));
  const declaresAdvanced = permissionIds.some((permission) => [
    "runtime.advanced", "companion.execute", "terminal.intercept.input", "terminal.intercept.output",
  ].includes(permission));
  const hasBrowser = Boolean(manifest?.main?.browser);
  const hasNode = Boolean(manifest?.main?.node);
  const defaultRuntimeKind = hasBrowser && !hasCompanions && !hasInterceptors ? "browser" : "utility";
  return {
    defaultRuntimeKind: isStaticThemePack(manifest) ? "data" : defaultRuntimeKind,
    dataOnly: isStaticThemePack(manifest),
    hasNode,
    declaresAdvanced,
    browserOnly: !manifest?.main?.data && hasBrowser && !hasNode && !hasCompanions && !hasInterceptors && !declaresAdvanced,
  };
}

function assertBrowserOnlyPlugin(manifest) {
  if (!describePluginRuntime(manifest).browserOnly && !isStaticThemePack(manifest)) {
    const error = new Error("This package requires advanced developer mode; normal plugin management accepts browser-only packages");
    error.code = "PLUGIN_UNSUPPORTED_RUNTIME";
    throw error;
  }
}

module.exports = { describePluginRuntime, assertBrowserOnlyPlugin, isStaticThemePack };
