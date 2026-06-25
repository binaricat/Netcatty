#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { listCattyToolSpecs } = require("../electron/capabilities/codegen/toolSurfaces.cjs");

const outputPath = path.join(
  __dirname,
  "../infrastructure/ai/harness/generated/cattyToolSpecs.json",
);

const specs = listCattyToolSpecs();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(specs, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${specs.length} Catty tool specs to ${outputPath}\n`);
