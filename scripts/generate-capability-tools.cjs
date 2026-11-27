#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AGENT_KINDS, listAgentToolSpecs, listCattyToolSpecs } = require("../electron/capabilities/codegen/toolSurfaces.cjs");

const generatedDir = path.join(
  __dirname,
  "../infrastructure/ai/harness/generated",
);

function writeSpecs(filename, specs) {
  const outputPath = path.join(generatedDir, filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(specs, null, 2)}\n`, "utf8");
  return { outputPath, count: specs.length };
}

const sidebarSpecs = listCattyToolSpecs();
const globalAgentSpecs = listAgentToolSpecs(AGENT_KINDS.GLOBAL);

const sidebar = writeSpecs("cattyToolSpecs.json", sidebarSpecs);
const globalAgent = writeSpecs("globalAgentToolSpecs.json", globalAgentSpecs);

const globalByCapabilityId = {};
for (const spec of globalAgentSpecs) {
  if (spec.capabilityId && spec.toolName && !globalByCapabilityId[spec.capabilityId]) {
    globalByCapabilityId[spec.capabilityId] = spec.toolName;
  }
}
const sidebarByRpcMethod = {};
for (const spec of sidebarSpecs) {
  if (spec.rpcMethod && spec.toolName && !sidebarByRpcMethod[spec.rpcMethod]) {
    sidebarByRpcMethod[spec.rpcMethod] = spec.toolName;
  }
}
const indexOutputPath = path.join(generatedDir, "toolNameIndex.json");
fs.writeFileSync(
  indexOutputPath,
  `${JSON.stringify({ globalByCapabilityId, sidebarByRpcMethod }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Wrote ${sidebar.count} sidebar tool specs to ${sidebar.outputPath}\n`);
process.stdout.write(`Wrote ${globalAgent.count} global agent tool specs to ${globalAgent.outputPath}\n`);
process.stdout.write(`Wrote compact tool name index to ${indexOutputPath}\n`);
