"use strict";

const constants = require("./constants.cjs");
const catalog = require("./catalog/index.cjs");
const registry = require("./registry.cjs");
const policy = require("./policy.cjs");
const rpcTimeouts = require("./rpcTimeouts.cjs");
const rpcTransport = require("./rpcTransport.cjs");
const dispatch = require("./dispatch.cjs");
const scope = require("./scope.cjs");
const adapters = require("./adapters/index.cjs");
const services = require("./services/index.cjs");

module.exports = {
  ...constants,
  ...catalog,
  ...registry,
  ...policy,
  ...rpcTimeouts,
  ...rpcTransport,
  ...dispatch,
  ...scope,
  ...adapters,
  ...services,
};
