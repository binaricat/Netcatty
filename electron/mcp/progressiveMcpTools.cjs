"use strict";

const { z } = require("zod");
const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
const { registerMcpTools } = require("../capabilities/codegen/mcpToolRegistry.cjs");

const MCP_TOOL_LOADER_NAME = "load_netcatty_tools";

// Keep the initial MCP surface small so clients can select common terminal and
// file tools reliably. The loader is the fifteenth initially visible tool.
const CORE_MCP_TOOL_NAMES = Object.freeze([
  "get_environment",
  "session_close",
  "terminal_execute",
  "terminal_start",
  "terminal_poll",
  "terminal_stop",
  "sftp_list",
  "sftp_read_file",
  "sftp_write_file",
  "sftp_download",
  "sftp_upload",
  "vault_hosts_list",
  "host_open",
  "terminal_read_context",
]);

const DEFERRED_MCP_TOOLSETS = Object.freeze({
  attachments: Object.freeze([
    "list_attachments",
    "read_attachment",
  ]),
  sftp_advanced: Object.freeze([
    "sftp_stat",
    "sftp_home",
    "sftp_mkdir",
    "sftp_delete",
    "sftp_rename",
    "sftp_chmod",
  ]),
  vault_hosts: Object.freeze([
    "host_get",
    "vault_hosts_create",
    "vault_hosts_update",
    "vault_hosts_delete",
    "vault_hosts_import",
    "host_notes_get",
    "host_notes_set",
    "vault_identities_list",
    "vault_proxy_profiles_list",
    "vault_groups_list",
    "vault_groups_create",
    "vault_groups_update",
    "vault_groups_delete",
  ]),
  vault_notes: Object.freeze([
    "vault_notes_list",
    "vault_notes_get",
    "vault_notes_create",
    "vault_notes_update",
    "vault_notes_delete",
  ]),
  snippets: Object.freeze([
    "snippets_list",
    "snippets_get",
    "snippets_run",
    "snippets_create",
    "snippets_update",
    "snippets_delete",
  ]),
  scripts: Object.freeze([
    "scripts_list",
    "scripts_get",
    "scripts_create",
    "scripts_update",
    "scripts_delete",
    "scripts_run",
    "scripts_reference",
    "scripts_runs_list",
    "scripts_run_stop",
    "scripts_run_pause",
    "scripts_run_resume",
    "scripts_targets_set",
    "host_connect_scripts_list",
    "host_connect_scripts_set",
  ]),
  portforward: Object.freeze([
    "portforward_rules_list",
    "portforward_tunnels_list",
    "portforward_rules_create",
    "portforward_rules_update",
    "portforward_rules_duplicate",
    "portforward_rules_delete",
    "portforward_start",
    "portforward_stop",
  ]),
});

const DEFERRED_MCP_TOOLSET_NAMES = Object.freeze(Object.keys(DEFERRED_MCP_TOOLSETS));
const LOADABLE_MCP_TOOLSET_NAMES = Object.freeze([...DEFERRED_MCP_TOOLSET_NAMES, "all"]);

function buildProgressiveMcpCatalog(toolDefs = listMcpTools()) {
  const toolsByName = new Map(toolDefs.map(tool => [tool.mcpTool, tool]));
  const assignedNames = [...CORE_MCP_TOOL_NAMES];
  for (const toolset of DEFERRED_MCP_TOOLSET_NAMES) {
    assignedNames.push(...DEFERRED_MCP_TOOLSETS[toolset]);
  }

  const duplicates = assignedNames.filter((name, index) => assignedNames.indexOf(name) !== index);
  const unknown = assignedNames.filter(name => !toolsByName.has(name));
  const assignedSet = new Set(assignedNames);
  const missing = toolDefs
    .map(tool => tool.mcpTool)
    .filter(name => !assignedSet.has(name));

  if (duplicates.length || unknown.length || missing.length) {
    throw new Error(`Invalid progressive MCP tool mapping: ${JSON.stringify({
      duplicates: [...new Set(duplicates)],
      unknown,
      missing,
    })}`);
  }

  return {
    toolsByName,
    coreTools: CORE_MCP_TOOL_NAMES.map(name => toolsByName.get(name)),
    deferredToolNames: assignedNames.slice(CORE_MCP_TOOL_NAMES.length),
  };
}

function parseLoaderResult(result) {
  return JSON.stringify(result, null, 2);
}

/**
 * Register the 15-tool initial MCP surface and add catalog tools on demand.
 * This loader is transport control, not a Netcatty product capability, so it
 * intentionally lives outside the capability catalog.
 */
function registerProgressiveMcpTools(server, deps, toolDefs = listMcpTools()) {
  const { toolsByName, coreTools, deferredToolNames } = buildProgressiveMcpCatalog(toolDefs);
  const loadedNames = new Set(CORE_MCP_TOOL_NAMES);

  server.tool(
    MCP_TOOL_LOADER_NAME,
    "Load more Netcatty tools by category. Choose attachments, sftp_advanced, vault_hosts, vault_notes, snippets, scripts, portforward, or all. Newly loaded tools appear immediately without restarting the MCP server.",
    {
      toolset: z.enum(LOADABLE_MCP_TOOLSET_NAMES).describe("Netcatty tool category to load"),
    },
    async ({ toolset }) => {
      const requestedNames = toolset === "all"
        ? deferredToolNames
        : DEFERRED_MCP_TOOLSETS[toolset];
      const newlyLoaded = requestedNames.filter(name => !loadedNames.has(name));
      const alreadyLoaded = requestedNames.filter(name => loadedNames.has(name));

      if (newlyLoaded.length > 0) {
        registerMcpTools(
          server,
          deps,
          newlyLoaded.map(name => toolsByName.get(name)),
        );
        for (const name of newlyLoaded) loadedNames.add(name);
      }

      return {
        content: [{
          type: "text",
          text: parseLoaderResult({
            toolset,
            newlyLoaded,
            alreadyLoaded,
            availableToolsets: LOADABLE_MCP_TOOLSET_NAMES,
            loadedCatalogToolCount: loadedNames.size,
            visibleToolCount: loadedNames.size + 1,
            remainingCatalogToolCount: toolDefs.length - loadedNames.size,
          }),
        }],
      };
    },
  );

  registerMcpTools(server, deps, coreTools);
  return {
    initialToolCount: coreTools.length + 1,
    loadedNames,
  };
}

module.exports = {
  CORE_MCP_TOOL_NAMES,
  DEFERRED_MCP_TOOLSETS,
  DEFERRED_MCP_TOOLSET_NAMES,
  LOADABLE_MCP_TOOLSET_NAMES,
  MCP_TOOL_LOADER_NAME,
  buildProgressiveMcpCatalog,
  registerProgressiveMcpTools,
};
