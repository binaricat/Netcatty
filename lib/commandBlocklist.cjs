"use strict";

const DEFAULT_COMMAND_BLOCKLIST = [
  // rm with recursive+force in any order/form targeting root
  "\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+)?|-[a-zA-Z]*f[a-zA-Z]*\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+)?|--recursive\\s+|--force\\s+){1,}",
  "\\bmkfs\\.",
  "\\bdd\\s+if=.*\\s+of=/dev/",
  "\\b(shutdown|reboot|poweroff|halt)\\b",
  ":\\(\\)\\{\\s*:\\|:\\&\\s*\\};:",
  ">\\s*/dev/sd",
  "\\bchmod\\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\\s+777\\s+/",
  "\\bmv\\s+/\\s",
  ":\\s*>\\s*/etc/",
  "\\bcurl\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b",
  "\\bwget\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b",
  // Common bypass techniques (defense-in-depth, not a security boundary)
  "base64.*\\|.*(?:ba)?sh",
  "\\beval\\b",
  "\\$\\(",
  "`.+`",
];

module.exports = DEFAULT_COMMAND_BLOCKLIST;
module.exports.DEFAULT_COMMAND_BLOCKLIST = DEFAULT_COMMAND_BLOCKLIST;
