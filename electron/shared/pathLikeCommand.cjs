"use strict";

function isPathLikeCommand(command) {
  const normalized = String(command || "").trim();
  return normalized.includes("/") || normalized.includes("\\") || /^[a-z]:/i.test(normalized);
}

function getCommandBasename(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/);
  return (parts.pop() || "").toLowerCase();
}

module.exports = {
  isPathLikeCommand,
  getCommandBasename,
};
