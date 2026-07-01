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

function compilePattern(pattern) {
  if (pattern instanceof RegExp || isRegExpLike(pattern)) return pattern;
  if (typeof pattern !== "string") {
    throw new TypeError("waitFor pattern must be a string or RegExp");
  }
  const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashMatch) {
    return new RegExp(slashMatch[1], slashMatch[2]);
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped);
}

function tryMatch(text, pattern) {
  const regex = compilePattern(pattern);
  const match = regex.exec(text);
  if (!match) return null;
  return match[0];
}

function tryMatchWithEnd(text, pattern) {
  const regex = compilePattern(pattern);
  if (typeof regex.lastIndex === "number") regex.lastIndex = 0;
  const match = regex.exec(text);
  if (!match || match.index === undefined) return null;
  return {
    value: match[0],
    endOffset: match.index + match[0].length,
  };
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

  consumeFreshPendingMatch(pattern) {
    while (true) {
      const matched = this.tryMatchPending(pattern);
      if (matched === null) return null;
      const absoluteEnd = this.scanOffset + matched.endOffset;
      if (isFreshTailMatch(this.getText().length, absoluteEnd)) {
        return matched;
      }
      this.advanceScanOffset(matched.endOffset);
    }
  }

  consumeFreshPendingMatchAny(patterns) {
    for (let index = 0; index < patterns.length; index += 1) {
      const pattern = patterns[index];
      while (true) {
        const matched = this.tryMatchPending(pattern);
        if (matched === null) break;
        const absoluteEnd = this.scanOffset + matched.endOffset;
        if (isFreshTailMatch(this.getText().length, absoluteEnd)) {
          return { index, matched };
        }
        this.advanceScanOffset(matched.endOffset);
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
      const matched = this.consumeFreshPendingMatch(waiter.pattern);
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

  waitFor(pattern, timeoutMs = 30000, shouldAbort) {
    const immediate = this.consumeFreshPendingMatch(pattern);
    if (immediate !== null) {
      this.advanceScanOffset(immediate.endOffset);
      return Promise.resolve(immediate.value);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
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

  abortWaiters(reason = "Script stopped") {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (waiter.abortInterval) clearInterval(waiter.abortInterval);
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
    const fresh = this.consumeFreshPendingMatchAny(patterns);
    if (fresh !== null) {
      this.advanceScanOffset(fresh.matched.endOffset);
      return fresh.index;
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        patterns,
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
          const fresh = this.consumeFreshPendingMatchAny(patterns);
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
