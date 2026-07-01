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

const sidebar = writeSpecs("cattyToolSpecs.json", listCattyToolSpecs());
const globalAgent = writeSpecs(
  "globalAgentToolSpecs.json",
  listAgentToolSpecs(AGENT_KINDS.GLOBAL),
);

process.stdout.write(`Wrote ${sidebar.count} sidebar tool specs to ${sidebar.outputPath}\n`);
process.stdout.write(`Wrote ${globalAgent.count} global agent tool specs to ${globalAgent.outputPath}\n`);
