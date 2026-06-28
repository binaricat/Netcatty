"use strict";

const DEFAULT_BUFFER_SIZE = 1024 * 1024;

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
  const match = regex.exec(text);
  if (!match || match.index === undefined) return null;
  return {
    value: match[0],
    endOffset: match.index + match[0].length,
  };
}

class SessionOutputBuffer {
  constructor(sessionId, maxSize = DEFAULT_BUFFER_SIZE) {
    this.sessionId = sessionId;
    this.maxSize = maxSize;
    this.chunks = [];
    this.totalLength = 0;
    this.scanOffset = 0;
    this.waiters = [];
  }

  append(data) {
    if (!data) return;
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

  advanceScanOffset(endOffset) {
    const absoluteEnd = this.scanOffset + endOffset;
    this.scanOffset = Math.min(absoluteEnd, this.getText().length);
  }

  clear() {
    this.chunks = [];
    this.totalLength = 0;
    this.scanOffset = 0;
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
      const matched = this.tryMatchPending(waiter.pattern);
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
    const immediate = this.tryMatchPending(pattern);
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

  async waitForAny(patterns, timeoutMs = 30000, shouldAbort) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new TypeError("waitForAny requires a non-empty patterns array");
    }
    for (let index = 0; index < patterns.length; index += 1) {
      const matched = this.tryMatchPending(patterns[index]);
      if (matched !== null) {
        this.advanceScanOffset(matched.endOffset);
        return index;
      }
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
          for (let index = 0; index < patterns.length; index += 1) {
            const matched = this.tryMatchPending(patterns[index]);
            if (matched !== null) {
              this.advanceScanOffset(matched.endOffset);
              clearTimeout(waiter.timer);
              if (waiter.interval) clearInterval(waiter.interval);
              if (waiter.abortInterval) clearInterval(waiter.abortInterval);
              this.waiters = this.waiters.filter((entry) => entry.custom !== waiter);
              resolve(index);
              return true;
            }
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
