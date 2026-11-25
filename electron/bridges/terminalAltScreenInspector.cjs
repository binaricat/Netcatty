"use strict";

const ESC = "\x1b";
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

function readCsiSequence(input, startIndex) {
  if (input[startIndex] !== ESC || input[startIndex + 1] !== "[") return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { sequence: input.slice(startIndex, index + 1), end: index + 1 };
    }
  }
  return null;
}

function getAlternateScreenAction(sequence) {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  const final = sequence.at(-1);
  if (final !== "h" && final !== "l") return null;
  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;
  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
  if (!modes.some((mode) => ALT_SCREEN_MODES.has(mode))) return null;
  return final === "h" ? "enter" : "leave";
}

function inspectAlternateScreenWindow(text) {
  let mayAffectTerminalState = false;
  let finalAction = null;
  let hasIncompleteSequence = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESC) continue;
    const sequence = readCsiSequence(text, index);
    if (sequence) {
      const action = getAlternateScreenAction(sequence.sequence);
      if (action) {
        mayAffectTerminalState = true;
        finalAction = action;
      }
      index = sequence.end - 1;
      continue;
    }
    if (text.slice(index).startsWith("\x1b[?")) {
      mayAffectTerminalState = true;
      hasIncompleteSequence = true;
      finalAction = null;
    }
  }
  return { mayAffectTerminalState, finalAction, hasIncompleteSequence };
}

function inspectAlternateScreenSequenceStartedBeforeBoundary(text, boundary) {
  let mayAffectTerminalState = false;
  let finalAction = null;
  for (let index = 0; index < Math.min(boundary, text.length); index += 1) {
    if (text[index] !== ESC) continue;
    const sequence = readCsiSequence(text, index);
    if (!sequence) {
      if (text.slice(index).startsWith("\x1b[?")) {
        mayAffectTerminalState = true;
      }
      continue;
    }
    if (sequence.end > boundary) {
      const action = getAlternateScreenAction(sequence.sequence);
      if (action) {
        mayAffectTerminalState = true;
        finalAction = action;
      }
    }
    index = sequence.end - 1;
  }
  return { mayAffectTerminalState, finalAction };
}

function inspectDroppedTerminalState({
  droppedHead,
  droppedTail,
  retainedHead,
  droppedBytes,
}) {
  if (droppedBytes <= 0) {
    return { mayAffectTerminalState: false, finalAlternateScreenAction: undefined };
  }
  const headInspection = inspectAlternateScreenWindow(droppedHead);
  const tailContext = droppedTail === droppedHead ? droppedHead : droppedTail;
  const tailInspection = inspectAlternateScreenWindow(tailContext);
  const tailWithRetainedInspection = inspectAlternateScreenWindow(`${tailContext}${retainedHead}`);
  const splitTailInspection = inspectAlternateScreenSequenceStartedBeforeBoundary(
    `${tailContext}${retainedHead}`,
    tailContext.length,
  );
  const sampledBytes = droppedHead.length + (droppedTail === droppedHead ? 0 : droppedTail.length);
  const hasUninspectedMiddle = droppedBytes > sampledBytes;
  const finalAlternateScreenAction = splitTailInspection.finalAction
    || tailInspection.finalAction
    || (!hasUninspectedMiddle ? headInspection.finalAction : undefined)
    || undefined;
  return {
    mayAffectTerminalState: Boolean(
      headInspection.hasIncompleteSequence
      || tailWithRetainedInspection.hasIncompleteSequence
      || hasUninspectedMiddle
      || headInspection.finalAction
      || tailInspection.finalAction
      || splitTailInspection.mayAffectTerminalState
      || tailWithRetainedInspection.finalAction
    ),
    finalAlternateScreenAction,
  };
}

function mergeDroppedOutputMeta(previous, next) {
  if (!next) return previous;
  const nextAction = next.droppedOutputMayAffectTerminalState
    ? next.droppedOutputAlternateScreenAction
    : (next.droppedOutputAlternateScreenAction ?? previous?.droppedOutputAlternateScreenAction);
  const merged = {
    ...(previous || {}),
    ...next,
    droppedOutputMayAffectTerminalState: Boolean(
      previous?.droppedOutputMayAffectTerminalState
      || next.droppedOutputMayAffectTerminalState,
    ),
    droppedOutputAlternateScreenAction: nextAction,
  };
  if (!merged.droppedOutputAlternateScreenAction) {
    delete merged.droppedOutputAlternateScreenAction;
  }
  return merged;
}

module.exports = {
  readCsiSequence,
  getAlternateScreenAction,
  inspectAlternateScreenWindow,
  inspectAlternateScreenSequenceStartedBeforeBoundary,
  inspectDroppedTerminalState,
  mergeDroppedOutputMeta,
};
