"use strict";

const cliAdapter = require("./cliAdapter.cjs");
const mcpAdapter = require("./mcpAdapter.cjs");

module.exports = {
  ...cliAdapter,
  ...mcpAdapter,
};
