"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VAULT_HOSTS_VS_NOTES_GUIDANCE,
  appendVaultAgentGuidance,
} = require("./vaultAgentGuidance.cjs");

test("VAULT_HOSTS_VS_NOTES_GUIDANCE forbids note fallback for host creation", () => {
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /vault_hosts_create/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /NOT vault_notes_create/i);
  assert.match(VAULT_HOSTS_VS_NOTES_GUIDANCE, /do not silently create a Vault note/i);
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
