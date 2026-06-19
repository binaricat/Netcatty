import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./TerminalPopupPage.tsx", import.meta.url), "utf8");

test("popup terminals resolve complete host config and pass jump hosts into Terminal", () => {
  assert.match(source, /proxyProfiles,\s+knownHosts,\s+snippets,\s+snippetPackages,\s+groupConfigs,/);
  assert.match(source, /resolveTerminalSessionHost\(\{\s+session: config\.sourceSession,\s+hosts,\s+groupConfigs,\s+proxyProfiles,/);
  assert.match(source, /resolveTerminalChainHosts\(\{\s+host,\s+hosts,\s+groupConfigs,\s+proxyProfiles,/);
  assert.match(source, /chainHosts=\{chainHosts\}/);
});
