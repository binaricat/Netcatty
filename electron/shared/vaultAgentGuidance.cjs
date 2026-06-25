"use strict";

/**
 * Shared Vault tool-selection guidance for MCP external agents and get_environment.
 * Keep in sync with infrastructure/ai/cattyAgent/systemPrompt.ts (Catty sidebar).
 */
const VAULT_HOSTS_VS_NOTES_GUIDANCE =
  "Vault → Hosts vs Vault → Notes: When the user asks to add/create/import a host "
  + "(创建主机、添加主机、保存 SSH 连接凭据), use vault_hosts_create with dryRun=true first, "
  + "or vault_hosts_import for known export formats (PuTTY, MobaXterm, CSV, SecureCRT, ssh_config) — "
  + "NOT vault_notes_create. Extract hostname, username, password, port, group, tags, and label from the user's text; "
  + "put long admin tables or remarks in the host notes field (host_notes_set / Host Details metadata), "
  + "not Vault sidebar Notes. Use vault_notes_create or vault_notes_update ONLY when the user explicitly wants "
  + "markdown documentation in Vault → Notes (保险箱笔记 sidebar). "
  + "If vault_hosts_create or vault_hosts_import fails, report the error — do not silently create a Vault note instead.";

function appendVaultAgentGuidance(description) {
  const base = typeof description === "string" ? description.trim() : "";
  if (!base) return VAULT_HOSTS_VS_NOTES_GUIDANCE;
  if (base.includes("Vault → Hosts vs Vault → Notes")) return base;
  return `${base} ${VAULT_HOSTS_VS_NOTES_GUIDANCE}`;
}

module.exports = {
  VAULT_HOSTS_VS_NOTES_GUIDANCE,
  appendVaultAgentGuidance,
};
