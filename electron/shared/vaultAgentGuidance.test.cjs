"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VAULT_HOSTS_VS_NOTES_GUIDANCE,
  VAULT_NOTES_CLI_GUIDANCE,
  VAULT_SCRIPTS_GUIDANCE,
  appendVaultAgentGuidance,
} = require("./vaultAgentGuidance.cjs");

test("VAULT_HOSTS_VS_NOTES_GUIDANCE forbids note fallback for host creation", () => {
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /vault_hosts_create/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /NOT vault_notes_create/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /do not silently create a Vault note/i);
});

test("Skills + CLI notes guidance matches the MCP notes rules", () => {
  assert.match(VAULT_NOTES_CLI_GUIDANCE, /notes create or notes update ONLY when the user explicitly wants/i);
  assert.match(VAULT_NOTES_CLI_GUIDANCE, /notes import to import generated or attached markdown/i);
  assert.match(VAULT_NOTES_CLI_GUIDANCE, /vault host-notes set/i);
  assert.match(VAULT_NOTES_CLI_GUIDANCE, /do not silently create a Vault note/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /vault_notes_import/i);
  assert.match(VAULT_NOTES_CLI_GUIDANCE, /if approval is denied, stop/i);
});

test("VAULT_HOSTS_VS_NOTES_GUIDANCE routes unknown attached host files through AI extraction", () => {
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /attached/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /unknown/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /extract/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /vault_hosts_create/i);
});

test("appendVaultAgentGuidance appends guidance once", () => {
  const once = appendVaultAgentGuidance("Netcatty terminal manager.");
  assert.match(once, /Netcatty terminal manager/);
  assert.match(once, /Vault → Hosts vs Vault → Notes/);

  const twice = appendVaultAgentGuidance(once);
  assert.equal(twice, once);
});

test("VAULT_SCRIPTS_GUIDANCE prefers explicit wait APIs", () => {
  assert.match(VAULT_SCRIPTS_GUIDANCE, /waitForText\/waitForRegex/);
  assert.doesNotMatch(VAULT_SCRIPTS_GUIDANCE, /sendLine,\s*waitFor,\s*dialogs/);
});

test("VAULT_SCRIPTS_GUIDANCE avoids mustache template braces", () => {
  assert.doesNotMatch(VAULT_SCRIPTS_GUIDANCE, /\{\{/);
  assert.doesNotMatch(appendVaultAgentGuidance("Netcatty terminal manager."), /\{\{/);
});
