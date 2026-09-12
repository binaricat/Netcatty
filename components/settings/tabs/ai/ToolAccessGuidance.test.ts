import assert from "node:assert/strict";
import test from "node:test";

import { buildMcpOnboardingPrompt } from "./ToolAccessGuidance";

test("buildMcpOnboardingPrompt includes launcher and discovery env", () => {
  const prompt = buildMcpOnboardingPrompt("/opt/netcatty/launcher", "/tmp/discovery.json");
  assert.match(prompt, /netcatty-external/);
  assert.match(prompt, /\/opt\/netcatty\/launcher/);
  assert.match(prompt, /NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE=\/tmp\/discovery\.json/);
  assert.match(prompt, /get_environment/);
});

test("buildMcpOnboardingPrompt omits env line without discovery path", () => {
  const prompt = buildMcpOnboardingPrompt("/opt/netcatty/launcher", null);
  assert.match(prompt, /\/opt\/netcatty\/launcher/);
  assert.doesNotMatch(prompt, /NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE=/);
});

test("buildMcpOnboardingPrompt falls back to enable-External-MCP guidance", () => {
  const prompt = buildMcpOnboardingPrompt(null, null);
  assert.match(prompt, /External MCP/);
  assert.doesNotMatch(prompt, /Command: /);
});
