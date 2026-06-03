"use strict";

/**
 * Repair ~/.claude.json before the claude-agent-sdk subprocess reads it.
 * 1:1 port of craft options.ts ensureClaudeConfig(): a missing/empty/BOM-
 * prefixed/corrupted config (or a stale .backup / .corrupted.* sibling) makes
 * the Claude Code binary write plain-text recovery messages to stdout, which
 * the SDK transport rejects as "CLI output was not valid JSON".
 */
const { join } = require("node:path");
const { homedir } = require("node:os");
const { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } = require("node:fs");

const UTF8_BOM = "﻿";
let claudeConfigChecked = false;

function writeConfigSafe(configPath, content) {
  try {
    writeFileSync(configPath, content, "utf-8");
  } catch (err) {
    const code = err && err.code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM")) {
      const start = Date.now();
      while (Date.now() - start < 100) { /* brief busy wait, runs once at startup */ }
      try { writeFileSync(configPath, content, "utf-8"); } catch { /* best effort */ }
    }
  }
}

function ensureClaudeConfig() {
  if (claudeConfigChecked) return;
  claudeConfigChecked = true;

  const configPath = join(homedir(), ".claude.json");

  const backupPath = `${configPath}.backup`;
  if (existsSync(backupPath)) {
    try { unlinkSync(backupPath); } catch { /* best effort */ }
  }

  try {
    const homeDir = homedir();
    for (const file of readdirSync(homeDir)) {
      if (file.startsWith(".claude.json.corrupted.")) {
        try { unlinkSync(join(homeDir, file)); } catch { /* best effort */ }
      }
    }
  } catch { /* ignore — main repair below still runs */ }

  if (!existsSync(configPath)) {
    writeConfigSafe(configPath, "{}");
    return;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
    const hasBom = raw !== content;
    if (content.trim().length === 0) {
      writeConfigSafe(configPath, "{}");
      return;
    }
    JSON.parse(content);
    if (hasBom) writeConfigSafe(configPath, content);
  } catch {
    writeConfigSafe(configPath, "{}");
  }
}

function resetClaudeConfigCheck() {
  claudeConfigChecked = false;
}

module.exports = { ensureClaudeConfig, resetClaudeConfigCheck };
