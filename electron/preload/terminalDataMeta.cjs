"use strict";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTerminalDataMeta(meta) {
  if (!isRecord(meta)) return undefined;
  return { ...meta };
}

function hasMetaFields(meta) {
  return Boolean(meta && Object.keys(meta).length > 0);
}

function mergeTerminalDataMeta(first, second, options = {}) {
  const merged = {
    ...(normalizeTerminalDataMeta(first) || {}),
    ...(normalizeTerminalDataMeta(second) || {}),
  };

  const droppedOutputMayAffectTerminalState = Boolean(
    first?.droppedOutputMayAffectTerminalState
    || second?.droppedOutputMayAffectTerminalState
  );
  const droppedOutputAlternateScreenAction = second?.droppedOutputMayAffectTerminalState
    ? second?.droppedOutputAlternateScreenAction
    : (second?.droppedOutputAlternateScreenAction ?? first?.droppedOutputAlternateScreenAction);

  if (droppedOutputMayAffectTerminalState) {
    merged.droppedOutputMayAffectTerminalState = true;
  } else {
    delete merged.droppedOutputMayAffectTerminalState;
  }

  if (droppedOutputAlternateScreenAction) {
    merged.droppedOutputAlternateScreenAction = droppedOutputAlternateScreenAction;
  } else {
    delete merged.droppedOutputAlternateScreenAction;
  }

  if (options.preserveTerminalPerf !== true) {
    delete merged.terminalPerf;
  }

  return hasMetaFields(merged) ? merged : undefined;
}

module.exports = {
  mergeTerminalDataMeta,
};
