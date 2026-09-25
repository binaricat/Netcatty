"use strict";

/**
 * Shared Vault tool-selection guidance for MCP external agents and get_environment.
 * Keep in sync with infrastructure/ai/cattyAgent/systemPrompt.ts (Catty sidebar).
 */
const VAULT_HOSTS_VS_NOTES_GUIDANCE =
  "Vault → Hosts vs Vault → Notes: When the user asks to add/create/import a host "
  + "(创建主机、添加主机、保存 SSH 连接凭据), use vault_hosts_create with dryRun=true first, "
  + "or vault_hosts_import for known export formats (PuTTY, MobaXterm, CSV, SecureCRT, FinalShell, ssh_config) — "
  + "NOT vault_notes_create. For attached host files, use vault_hosts_import only when the attachment is a known export format; "
  + "for unknown attached host/server text, read the attachment content, extract hostname, username, password, port, group, tags, and label yourself, "
  + "then call vault_hosts_create with dryRun=true first. Extract hostname, username, password or local keyPath, port, group, tags, and label from the user's text; "
  + "put long admin tables or remarks in the host notes field (host_notes_set / Host Details metadata), "
  + "not Vault sidebar Notes. Use vault_notes_create or vault_notes_update ONLY when the user explicitly wants "
  + "markdown documentation in Vault → Notes (保险箱笔记 sidebar). "
  + "Use vault_notes_import to import generated or attached markdown as one or more sidebar notes. "
  + "Use vault_hosts_list to resolve hostId before vault_hosts_update or vault_hosts_delete. "
  + "If vault_hosts_create or vault_hosts_import fails, report the error — do not silently create a Vault note instead.";

/**
 * Skills + CLI wording for the same Vault Notes rules as VAULT_HOSTS_VS_NOTES_GUIDANCE.
 * Keep the selection rules aligned when either string changes.
 */
const VAULT_NOTES_CLI_GUIDANCE =
  "Vault sidebar Notes vs host metadata: use notes create or notes update ONLY when the user explicitly wants "
  + "markdown documentation in Vault → Notes. Use notes import to import generated or attached markdown as one or more sidebar notes "
  + "(--content plus --file-name for one document, or --documents for a batch). "
  + "Read a note with notes get --note-id using the exact id from notes list; follow nextOffset with --expected-updated-at until null "
  + "before summarizing or replacing the whole note. "
  + "Host Details metadata uses vault host-notes set, not notes create. "
  + "Do not create or import a Vault note when the user asked to add a host. "
  + "If a host operation fails, report the error — do not silently create a Vault note instead. "
  + "On notes update, an explicit empty --content clears the body and an explicit empty --group clears the folder; omit those flags to keep the current values. notes import accepts an empty --content. "
  + "notes create, notes update, notes delete, and notes import require user approval; if approval is denied, stop.";

const VAULT_SCRIPTS_GUIDANCE =
  "Snippets vs automation scripts: snippets_* for shell command text (optional named placeholders written with two curly braces on each side). "
  + "scripts_* for nct JavaScript automation (await nct.screen.sendLine, waitForText/waitForRegex, dialogs). "
  + "Call scripts_reference before authoring scripts. scripts_run with wait=true blocks until completion; "
  + "use scripts_runs_list / scripts_run_stop / scripts_run_pause / scripts_run_resume for lifecycle. "
  + "Triggers: manual, onConnect (runs after connect), onOutput (regex triggerPattern). "
  + "Host/group linking: scripts_targets_set supports targets and dynamic targetGroups; "
  + "per-host connect order: host_connect_scripts_list / host_connect_scripts_set.";

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
  VAULT_NOTES_CLI_GUIDANCE,
  VAULT_SCRIPTS_GUIDANCE,
  appendVaultAgentGuidance,
};
