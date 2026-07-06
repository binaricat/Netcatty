"use strict";

const DEFAULT_BUFFER_SIZE = 1024 * 1024;
/** Matches within this many bytes of buffer end count as live terminal output. */
const FRESH_MATCH_TAIL_SLACK = 512;

function isFreshTailMatch(textLength, matchEndAbsolute) {
  return matchEndAbsolute >= textLength - FRESH_MATCH_TAIL_SLACK;
}

function isRegExpLike(pattern) {
  return Boolean(
    pattern
    && typeof pattern === "object"
    && typeof pattern.exec === "function"
    && typeof pattern.test === "function",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUnescapedCharAt(source, index, char) {
  if (source[index] !== char) return false;
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}

function isRegexCompatibleWaitPattern(pattern) {
  return pattern instanceof RegExp || isRegExpLike(pattern);
}

function edgeDotRepeatTokenLengthAt(source, index) {
  if (source[index] !== ".") return 0;
  const quantifier = source[index + 1];
  if (quantifier !== "*" && quantifier !== "+") return 0;
  if (!hasUnescapedCharAt(source, index, ".")) return 0;
  return source[index + 2] === "?" ? 3 : 2;
}

function stripEdgeDotRepeats(source) {
  let start = 0;
  let end = source.length;
  if (hasUnescapedCharAt(source, start, "^")) {
    start += 1;
  }
  if (end > start && hasUnescapedCharAt(source, end - 1, "$")) {
    end -= 1;
  }

  while (start < end) {
    const tokenLength = edgeDotRepeatTokenLengthAt(source, start);
    if (tokenLength === 0) break;
    start += tokenLength;
  }
  while (end - start >= 2) {
    const lazyTokenLength = edgeDotRepeatTokenLengthAt(source, end - 3);
    if (lazyTokenLength === 3) {
      end -= 3;
      continue;
    }
    const greedyTokenLength = edgeDotRepeatTokenLengthAt(source, end - 2);
    if (greedyTokenLength !== 2) break;
    end -= 2;
  }
  return source.slice(start, end);
}

function getRegExpFlags(regex, fallbackFlags = "") {
  if (typeof regex.flags === "string") return regex.flags;
  let flags = fallbackFlags;
  if (regex.global && !flags.includes("g")) flags += "g";
  if (regex.ignoreCase && !flags.includes("i")) flags += "i";
  if (regex.multiline && !flags.includes("m")) flags += "m";
  if (regex.dotAll && !flags.includes("s")) flags += "s";
  if (regex.unicode && !flags.includes("u")) flags += "u";
  if (regex.sticky && !flags.includes("y")) flags += "y";
  return flags;
}

function compilePattern(pattern) {
  if (pattern instanceof RegExp || isRegExpLike(pattern)) return pattern;
  if (typeof pattern !== "string") {
    throw new TypeError("waitFor pattern must be a string or RegExp");
  }
  const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashMatch) {
    return new RegExp(slashMatch[1], slashMatch[2]);
  }
  return new RegExp(escapeRegExp(pattern));
}

function compileTextPattern(text) {
  if (typeof text !== "string") {
    throw new TypeError("waitForText pattern must be a string");
  }
  return new RegExp(escapeRegExp(text));
}

function compileRegexPattern(pattern) {
  if (pattern instanceof RegExp || isRegExpLike(pattern)) return pattern;
  if (typeof pattern !== "string") {
    throw new TypeError("waitForRegex pattern must be a string or RegExp");
  }
  const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashMatch) {
    const flags = slashMatch[2].includes("s") ? slashMatch[2] : `${slashMatch[2]}s`;
    return new RegExp(slashMatch[1], flags);
  }
  return new RegExp(pattern, "s");
}

function compileRegexFreshnessPattern(pattern) {
  const regex = compileRegexPattern(pattern);
  const source = typeof regex.source === "string" ? regex.source : String(pattern);
  const strippedSource = stripEdgeDotRepeats(source);
  if (!strippedSource || strippedSource === source) return null;
  const flags = getRegExpFlags(regex).replace(/y/g, "");
  const globalFlags = flags.includes("g") ? flags : `${flags}g`;
  try {
    return new RegExp(strippedSource, globalFlags);
  } catch {
    return null;
  }
}

function tryMatch(text, pattern) {
  const regex = compilePattern(pattern);
  const match = regex.exec(text);
  if (!match) return null;
  return match[0];
}

function tryMatchWithEnd(text, pattern, compiler = compilePattern) {
  const regex = compiler(pattern);
  if (typeof regex.lastIndex === "number") regex.lastIndex = 0;
  const match = regex.exec(text);
  if (!match || match.index === undefined) return null;
  return {
    value: match[0],
    endOffset: match.index + match[0].length,
  };
}

function tryRegexMatchWithEnd(text, pattern) {
  const regex = compileRegexPattern(pattern);
  if (typeof regex.lastIndex === "number") regex.lastIndex = 0;
  const match = regex.exec(text);
  if (!match || match.index === undefined) return null;

  const value = match[0];
  let freshStartOffset = match.index;
  let freshEndOffset = match.index + value.length;
  const freshnessRegex = compileRegexFreshnessPattern(pattern);
  if (freshnessRegex) {
    if (typeof freshnessRegex.lastIndex === "number") freshnessRegex.lastIndex = 0;
    let freshMatch = freshnessRegex.exec(value);
    let latestFreshStartOffset = null;
    let latestFreshEndOffset = null;
    while (freshMatch && freshMatch.index !== undefined) {
      const startOffset = freshMatch.index;
      const endOffset = freshMatch.index + freshMatch[0].length;
      if (latestFreshEndOffset === null || endOffset >= latestFreshEndOffset) {
        latestFreshStartOffset = startOffset;
      }
      latestFreshEndOffset = Math.max(latestFreshEndOffset ?? 0, endOffset);
      if (freshMatch[0].length === 0) {
        freshnessRegex.lastIndex += 1;
      }
      freshMatch = freshnessRegex.exec(value);
    }
    if (latestFreshEndOffset !== null) {
      freshStartOffset = match.index + latestFreshStartOffset;
      freshEndOffset = match.index + latestFreshEndOffset;
    }
  }

  return {
    value,
    startOffset: match.index,
    endOffset: match.index + value.length,
    freshStartOffset,
    freshEndOffset,
  };
}

function staleAdvanceEndOffset(matched) {
  return Math.max(Number(matched?.endOffset) || 0, 1);
}

function staleRegexAdvanceEndOffset(matched) {
  return Math.max((Number(matched?.startOffset) || 0) + 1, 1);
}

function findFreshTailMatchAny(text, patterns) {
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    let offset = 0;
    while (offset <= text.length) {
      const matched = tryMatchWithEnd(text.slice(offset), pattern);
      if (matched === null) break;
      const absoluteEnd = offset + matched.endOffset;
      if (isFreshTailMatch(text.length, absoluteEnd)) {
        return {
          index,
          matched: {
            value: matched.value,
            endOffset: absoluteEnd,
          },
        };
      }
      offset = Math.max(absoluteEnd, offset + 1);
    }
  }
  return null;
}

function findMatchingPreservedTailMatch(text, patterns, preserved) {
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    let offset = 0;
    while (offset <= text.length) {
      const matched = tryMatchWithEnd(text.slice(offset), pattern);
      if (matched === null) break;
      const absoluteEnd = offset + matched.endOffset;
      if (absoluteEnd === preserved.endOffset && matched.value === preserved.value) {
        return {
          index,
          matched: {
            value: matched.value,
            endOffset: absoluteEnd,
          },
        };
      }
      offset = Math.max(absoluteEnd, offset + 1);
    }
  }
  return null;
}

class SessionOutputBuffer {
  constructor(sessionId, maxSize = DEFAULT_BUFFER_SIZE) {
    this.sessionId = sessionId;
    this.maxSize = maxSize;
    this.chunks = [];
    this.totalLength = 0;
    this.scanOffset = 0;
    this.waiters = [];
    this.preservedTailMatch = null;
  }

  append(data) {
    if (!data) return;
    this.preservedTailMatch = null;
    this.chunks.push(String(data));
    this.totalLength += this.chunks[this.chunks.length - 1].length;
    while (this.totalLength > this.maxSize && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      const removedLength = removed.length;
      this.totalLength -= removedLength;
      this.scanOffset = Math.max(0, this.scanOffset - removedLength);
      for (const waiter of this.waiters) {
        if (typeof waiter.freshBoundary === "number") {
          waiter.freshBoundary = Math.max(0, waiter.freshBoundary - removedLength);
        }
        if (waiter.custom && typeof waiter.custom.freshBoundary === "number") {
          waiter.custom.freshBoundary = Math.max(0, waiter.custom.freshBoundary - removedLength);
        }
      }
    }
    this.flushWaiters();
  }

  getText() {
    return this.chunks.join("");
  }

  getPendingText() {
    return this.getText().slice(this.scanOffset);
  }

  tryMatchPending(pattern) {
    return tryMatchWithEnd(this.getPendingText(), pattern);
  }

  tryMatchPendingText(text) {
    return tryMatchWithEnd(this.getPendingText(), text, compileTextPattern);
  }

  tryMatchPendingRegex(pattern) {
    return tryRegexMatchWithEnd(this.getPendingText(), pattern);
  }

  currentFreshBoundary() {
    return Math.max(this.scanOffset, this.getText().length - FRESH_MATCH_TAIL_SLACK);
  }

  consumeFreshPendingMatch(pattern, freshBoundary = this.currentFreshBoundary()) {
    while (true) {
      const matched = this.tryMatchPending(pattern);
      if (matched === null) return null;
      const absoluteEnd = this.scanOffset + matched.endOffset;
      if (absoluteEnd >= freshBoundary) {
        return matched;
      }
      this.advanceScanOffset(staleAdvanceEndOffset(matched));
    }
  }

  consumeFreshPendingText(text, freshBoundary = this.currentFreshBoundary()) {
    while (true) {
      const matched = this.tryMatchPendingText(text);
      if (matched === null) return null;
      const absoluteEnd = this.scanOffset + matched.endOffset;
      if (absoluteEnd >= freshBoundary) {
        return matched;
      }
      this.advanceScanOffset(staleAdvanceEndOffset(matched));
    }
  }

  consumeFreshPendingRegex(pattern, options = {}) {
    const fallbackBoundary = this.currentFreshBoundary();
    const text = this.getText();
    const baseOffset = this.scanOffset;
    const pendingText = text.slice(baseOffset);
    let relativeOffset = 0;
    while (relativeOffset <= pendingText.length) {
      const matched = tryRegexMatchWithEnd(pendingText.slice(relativeOffset), pattern);
      if (matched === null) {
        if (relativeOffset > 0) {
          this.scanOffset = Math.min(baseOffset + relativeOffset, text.length);
        }
        return null;
      }
      const minFreshStartAbsolute = Number.isFinite(options.minFreshStartAbsolute)
        ? options.minFreshStartAbsolute
        : null;
      const absoluteStart = baseOffset + relativeOffset + matched.freshStartOffset;
      const matchStartAbsolute = baseOffset + relativeOffset + matched.startOffset;
      const freshBoundary = minFreshStartAbsolute === null ? fallbackBoundary : minFreshStartAbsolute;
      if (absoluteStart >= freshBoundary) {
        let value = matched.value;
        if (minFreshStartAbsolute !== null && matchStartAbsolute < minFreshStartAbsolute) {
          const valueFreshStart = matched.freshStartOffset - matched.startOffset;
          const lineStart = matched.value.lastIndexOf("\n", Math.max(0, valueFreshStart - 1));
          const valueStart = lineStart >= 0 ? lineStart : Math.max(0, valueFreshStart);
          value = matched.value.slice(valueStart);
        }
        return {
          ...matched,
          value,
          endOffset: relativeOffset + matched.endOffset,
        };
      }
      relativeOffset += staleRegexAdvanceEndOffset(matched);
    }
    this.scanOffset = Math.min(baseOffset + relativeOffset, text.length);
    return null;
  }

  consumeFreshPendingMatchAny(patterns, freshBoundary = this.currentFreshBoundary()) {
    for (let index = 0; index < patterns.length; index += 1) {
      const pattern = patterns[index];
      while (true) {
        const matched = this.tryMatchPending(pattern);
        if (matched === null) break;
        const absoluteEnd = this.scanOffset + matched.endOffset;
        if (absoluteEnd >= freshBoundary) {
          return { index, matched };
        }
        this.advanceScanOffset(staleAdvanceEndOffset(matched));
      }
    }
    return null;
  }

  advanceScanOffset(endOffset) {
    const absoluteEnd = this.scanOffset + endOffset;
    this.scanOffset = Math.min(absoluteEnd, this.getText().length);
  }

  markCurrentOutputConsumed(options = {}) {
    this.markOutputConsumedThrough(this.getText().length, options);
  }

  markOutputConsumedThrough(length, options = {}) {
    const text = this.getText();
    const consumedLength = Math.max(0, Math.min(Number(length) || 0, text.length));
    const consumedText = text.slice(0, consumedLength);
    this.scanOffset = consumedLength;
    this.preservedTailMatch = null;

    const preserveTailPatterns = Array.isArray(options.preserveTailPatterns)
      ? options.preserveTailPatterns
      : [];
    if (preserveTailPatterns.length === 0 || consumedText.length === 0) return;

    const fresh = findFreshTailMatchAny(consumedText, preserveTailPatterns);
    if (fresh === null) return;
    this.preservedTailMatch = {
      textLength: consumedText.length,
      value: fresh.matched.value,
      endOffset: fresh.matched.endOffset,
    };
  }

  consumePreservedTailMatchAny(patterns) {
    const preserved = this.preservedTailMatch;
    if (!preserved) return null;
    const text = this.getText();
    if (text.length !== preserved.textLength) {
      this.preservedTailMatch = null;
      return null;
    }

    const fresh = findMatchingPreservedTailMatch(text, patterns, preserved);
    if (fresh === null) return null;

    this.preservedTailMatch = null;
    return fresh;
  }

  clear() {
    this.chunks = [];
    this.totalLength = 0;
    this.scanOffset = 0;
    this.preservedTailMatch = null;
  }

  flushWaiters() {
    if (this.waiters.length === 0) return;
    const remaining = [];
    for (const waiter of this.waiters) {
      if (waiter.custom) {
        if (!waiter.custom.check()) {
          remaining.push(waiter);
        }
        continue;
      }
      const matched = this.consumeFreshPendingMatch(
        waiter.pattern,
        waiter.freshBoundary ?? this.currentFreshBoundary(),
      );
      if (matched !== null) {
        this.advanceScanOffset(matched.endOffset);
        clearTimeout(waiter.timer);
        if (waiter.abortInterval) clearInterval(waiter.abortInterval);
        waiter.resolve(matched.value);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  waitForWithMatcher({ pattern, timeoutMs, shouldAbort, consumeFreshMatch, timeoutLabel, freshBoundary }) {
    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        freshBoundary,
        resolve,
        reject,
        shouldAbort,
        timer: null,
        check: () => {
          const matched = consumeFreshMatch(waiter.freshBoundary);
          if (matched === null) return false;
          this.advanceScanOffset(matched.endOffset);
          clearTimeout(waiter.timer);
          if (waiter.abortInterval) clearInterval(waiter.abortInterval);
          this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
          resolve(matched.value);
          return true;
        },
      };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
        if (waiter.abortInterval) clearInterval(waiter.abortInterval);
        reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof shouldAbort === "function") {
        waiter.abortInterval = setInterval(() => {
          if (!shouldAbort()) return;
          clearTimeout(waiter.timer);
          clearInterval(waiter.abortInterval);
          this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
          reject(new Error("Script stopped"));
        }, 100);
      }
      this.waiters.push({
        pattern,
        resolve: () => {},
        reject,
        timer: waiter.timer,
        custom: waiter,
      });
    });
  }

  waitFor(pattern, timeoutMs = 30000, shouldAbort) {
    if (isRegexCompatibleWaitPattern(pattern)) {
      const minFreshStartAbsolute = Math.max(
        this.scanOffset,
        this.getText().length - FRESH_MATCH_TAIL_SLACK,
      );
      const immediate = this.consumeFreshPendingRegex(pattern, { minFreshStartAbsolute });
      if (immediate !== null) {
        this.advanceScanOffset(immediate.endOffset);
        return Promise.resolve(immediate.value);
      }

      return this.waitForWithMatcher({
        pattern,
        timeoutMs,
        shouldAbort,
        freshBoundary: minFreshStartAbsolute,
        consumeFreshMatch: (boundary) => this.consumeFreshPendingRegex(pattern, { minFreshStartAbsolute: boundary }),
        timeoutLabel: "waitFor",
      });
    }

    const freshBoundary = this.currentFreshBoundary();
    const immediate = this.consumeFreshPendingMatch(pattern, freshBoundary);
    if (immediate !== null) {
      this.advanceScanOffset(immediate.endOffset);
      return Promise.resolve(immediate.value);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        freshBoundary,
        resolve,
        reject,
        shouldAbort,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          if (waiter.abortInterval) clearInterval(waiter.abortInterval);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      if (typeof shouldAbort === "function") {
        waiter.abortInterval = setInterval(() => {
          if (!shouldAbort()) return;
          clearTimeout(waiter.timer);
          clearInterval(waiter.abortInterval);
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error("Script stopped"));
        }, 100);
      }
      this.waiters.push(waiter);
    });
  }

  waitForText(text, timeoutMs = 30000, shouldAbort) {
    const freshBoundary = this.currentFreshBoundary();
    const immediate = this.consumeFreshPendingText(text, freshBoundary);
    if (immediate !== null) {
      this.advanceScanOffset(immediate.endOffset);
      return Promise.resolve(immediate.value);
    }

    return this.waitForWithMatcher({
      pattern: text,
      timeoutMs,
      shouldAbort,
      freshBoundary,
      consumeFreshMatch: (boundary) => this.consumeFreshPendingText(text, boundary),
      timeoutLabel: "waitForText",
    });
  }

  waitForRegex(pattern, timeoutMs = 30000, shouldAbort) {
    const minFreshStartAbsolute = Math.max(
      this.scanOffset,
      this.getText().length - FRESH_MATCH_TAIL_SLACK,
    );
    const immediate = this.consumeFreshPendingRegex(pattern, { minFreshStartAbsolute });
    if (immediate !== null) {
      this.advanceScanOffset(immediate.endOffset);
      return Promise.resolve(immediate.value);
    }

    return this.waitForWithMatcher({
      pattern,
      timeoutMs,
      shouldAbort,
      freshBoundary: minFreshStartAbsolute,
      consumeFreshMatch: (boundary) => this.consumeFreshPendingRegex(pattern, { minFreshStartAbsolute: boundary }),
      timeoutLabel: "waitForRegex",
    });
  }

  abortWaiters(reason = "Script stopped") {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (waiter.abortInterval) clearInterval(waiter.abortInterval);
      if (waiter.custom?.abortInterval) clearInterval(waiter.custom.abortInterval);
      if (waiter.custom?.interval) clearInterval(waiter.custom.interval);
      waiter.reject?.(new Error(reason));
    }
    this.waiters = [];
  }

  async waitForAny(patterns, timeoutMs = 30000, shouldAbort, options = {}) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new TypeError("waitForAny requires a non-empty patterns array");
    }
    if (options.allowPreservedTailMatch === true) {
      const preserved = this.consumePreservedTailMatchAny(patterns);
      if (preserved !== null) {
        return preserved.index;
      }
    }
    const freshBoundary = this.currentFreshBoundary();
    const fresh = this.consumeFreshPendingMatchAny(patterns, freshBoundary);
    if (fresh !== null) {
      this.advanceScanOffset(fresh.matched.endOffset);
      return fresh.index;
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        patterns,
        freshBoundary,
        resolve,
        reject,
        shouldAbort,
        timer: null,
        interval: null,
        check: () => {
          if (options.allowPreservedTailMatch === true) {
            const preserved = this.consumePreservedTailMatchAny(patterns);
            if (preserved !== null) {
              clearTimeout(waiter.timer);
              if (waiter.interval) clearInterval(waiter.interval);
              if (waiter.abortInterval) clearInterval(waiter.abortInterval);
              this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
              resolve(preserved.index);
              return true;
            }
          }
          const fresh = this.consumeFreshPendingMatchAny(patterns, waiter.freshBoundary);
          if (fresh !== null) {
            this.advanceScanOffset(fresh.matched.endOffset);
            clearTimeout(waiter.timer);
            if (waiter.interval) clearInterval(waiter.interval);
            if (waiter.abortInterval) clearInterval(waiter.abortInterval);
            this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
            resolve(fresh.index);
            return true;
          }
          return false;
        },
      };
      waiter.timer = setTimeout(() => {
        if (waiter.interval) clearInterval(waiter.interval);
        if (waiter.abortInterval) clearInterval(waiter.abortInterval);
        this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
        reject(new Error(`waitForAny timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiter.interval = setInterval(() => {
        waiter.check();
      }, 50);
      if (typeof shouldAbort === "function") {
        waiter.abortInterval = setInterval(() => {
          if (!shouldAbort()) return;
          clearTimeout(waiter.timer);
          clearInterval(waiter.interval);
          clearInterval(waiter.abortInterval);
          this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
          reject(new Error("Script stopped"));
        }, 100);
      }
      this.waiters.push({
        pattern: patterns[0],
        resolve: () => {},
        reject: () => {},
        timer: waiter.timer,
        custom: waiter,
      });
    });
  }

  dispose() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (waiter.abortInterval) clearInterval(waiter.abortInterval);
      if (waiter.custom?.abortInterval) clearInterval(waiter.custom.abortInterval);
      if (waiter.custom?.interval) clearInterval(waiter.custom.interval);
      waiter.reject?.(new Error("Session output buffer disposed"));
    }
    this.waiters = [];
    this.chunks = [];
    this.totalLength = 0;
    this.scanOffset = 0;
    this.preservedTailMatch = null;
  }
}

const buffers = new Map();

function getOrCreateBuffer(sessionId) {
  if (!buffers.has(sessionId)) {
    buffers.set(sessionId, new SessionOutputBuffer(sessionId));
  }
  return buffers.get(sessionId);
}

function appendSessionOutput(sessionId, data) {
  getOrCreateBuffer(sessionId).append(data);
}

function removeSessionBuffer(sessionId) {
  const buffer = buffers.get(sessionId);
  if (buffer) {
    buffer.dispose();
    buffers.delete(sessionId);
  }
}

module.exports = {
  SessionOutputBuffer,
  appendSessionOutput,
  getOrCreateBuffer,
  removeSessionBuffer,
  tryMatch,
  compilePattern,
};
