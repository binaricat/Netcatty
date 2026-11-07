"use strict";

/**
 * Host-only adapter. Call with the host-assigned activation identity after the
 * caller guard; never pass plugin request params, manifest source claims or an
 * owner supplied by a plugin. Missing source APIs mean unknown provenance.
 */
function createPluginLogProvenanceResolver(database) {
  const methods = ["getActivePlugin", "getRetainedPluginSource", "privateOwner", "publicPluginId"];
  const resolve = (identity) => {
    if (!methods.every((method) => typeof database?.[method] === "function")) return null;
    const plugin = database.getActivePlugin(identity.pluginId);
    if (!plugin || plugin.id !== identity.pluginId
      || plugin.activeVersion !== identity.pluginVersion
      || plugin.archiveSha256 !== identity.archiveSha256) return null;
    const source = plugin.source;
    const retained = database.getRetainedPluginSource(identity.pluginId);
    if (!source || !retained || source.id !== retained.id || source.kind !== retained.kind) return null;
    const owner = database.privateOwner(identity.pluginId);
    if (typeof owner !== "string" || !owner || owner === identity.pluginId || database.publicPluginId(owner) !== identity.pluginId) return null;
    return { sourceId: source.id, sourceKind: source.kind, namespace: owner };
  };
  return (identity) => {
    const initial = resolve(identity);
    if (!initial) return null;
    return Object.freeze({ ...initial, isCurrent: () => {
      try {
        const current = resolve(identity);
        return current !== null && current.sourceId === initial.sourceId
          && current.sourceKind === initial.sourceKind && current.namespace === initial.namespace;
      } catch { return false; }
    } });
  };
}

module.exports = { createPluginLogProvenanceResolver };
