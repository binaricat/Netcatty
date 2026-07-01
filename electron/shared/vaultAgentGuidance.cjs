"use strict";

/**
 * Shared Vault tool-selection guidance for MCP external agents and get_environment.
 * Keep in sync with infrastructure/ai/cattyAgent/systemPrompt.ts (Catty sidebar).
 */
const VAULT_HOSTS_VS_NOTES_GUIDANCE =
  "Vault → Hosts vs Vault → Notes: When the user asks to add/create/import a host "
  + "(创建主机、添加主机、保存 SSH 连接凭据), use vault_hosts_create with dryRun=true first, "
  + "or vault_hosts_import for known export formats (PuTTY, MobaXterm, CSV, SecureCRT, ssh_config) — "
  + "NOT vault_notes_create. For attached host files, use vault_hosts_import only when the attachment is a known export format; "
  + "for unknown attached host/server text, read the attachment content, extract hostname, username, password, port, group, tags, and label yourself, "
  + "then call vault_hosts_create with dryRun=true first. Extract hostname, username, password, port, group, tags, and label from the user's text; "
  + "put long admin tables or remarks in the host notes field (host_notes_set / Host Details metadata), "
  + "not Vault sidebar Notes. Use vault_notes_create or vault_notes_update ONLY when the user explicitly wants "
  + "markdown documentation in Vault → Notes (保险箱笔记 sidebar). "
  + "If vault_hosts_create or vault_hosts_import fails, report the error — do not silently create a Vault note instead.";

const VAULT_SCRIPTS_GUIDANCE =
  "Snippets vs automation scripts: snippets_* for shell command text (optional {{variables}}). "
  + "scripts_* for nct JavaScript automation (await nct.screen.sendLine, waitFor, dialogs). "
  + "Call scripts_reference before authoring scripts. scripts_run with wait=true blocks until completion; "
  + "use scripts_runs_list / scripts_run_stop / scripts_run_pause / scripts_run_resume for lifecycle. "
  + "Triggers: manual, onConnect (runs after connect), onOutput (regex triggerPattern). "
  + "Host linking: scripts_targets_set; per-host connect order: host_connect_scripts_list / host_connect_scripts_set.";

function appendVaultAgentGuidance(description) {
  const base = typeof description === "string" ? description.trim() : "";
  let result = base;
  if (!result.includes("Vault → Hosts vs Vault → Notes")) {
    result = result ? `${result} ${VAULT_HOSTS_VS_NOTES_GUIDANCE}` : VAULT_HOSTS_VS_NOTES_GUIDANCE;
  }
  if (!result.includes("Snippets vs automation scripts")) {
    result = result ? `${result} ${VAULT_SCRIPTS_GUIDANCE}` : VAULT_SCRIPTS_GUIDANCE;
  }
  return result;
}

module.exports = {
  VAULT_HOSTS_VS_NOTES_GUIDANCE,
  VAULT_SCRIPTS_GUIDANCE,
  appendVaultAgentGuidance,
};
