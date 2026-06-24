"use strict";

const { META_CAPABILITIES } = require("./meta.cjs");
const { TERMINAL_CAPABILITIES } = require("./terminal.cjs");
const { SFTP_CAPABILITIES } = require("./sftp.cjs");
const { VAULT_CAPABILITIES } = require("./vault.cjs");
const { PORT_FORWARD_CAPABILITIES } = require("./portforward.cjs");

const ALL_CAPABILITIES = Object.freeze([
  ...META_CAPABILITIES,
  ...TERMINAL_CAPABILITIES,
  ...SFTP_CAPABILITIES,
  ...VAULT_CAPABILITIES,
  ...PORT_FORWARD_CAPABILITIES,
]);

module.exports = {
  META_CAPABILITIES,
  TERMINAL_CAPABILITIES,
  SFTP_CAPABILITIES,
  VAULT_CAPABILITIES,
  PORT_FORWARD_CAPABILITIES,
  ALL_CAPABILITIES,
};
