"use strict";

const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");

const mcpToolDescriptions = new Map(
  listMcpTools().map((tool) => [tool.mcpTool, tool.description]),
);

function getCatalogToolDescription(toolName) {
  return mcpToolDescriptions.get(toolName) || null;
}

function listCatalogMcpToolNames() {
  return [...mcpToolDescriptions.keys()];
}

module.exports = {
  getCatalogToolDescription,
  listCatalogMcpToolNames,
};
