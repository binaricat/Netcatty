"use strict";

const { EventEmitter } = require("node:events");
const Module = require("node:module");

/**
 * Create a lightweight fake Electron WebContents/sender that records IPC sends.
 */
function createMockWebContents(overrides = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  let destroyed = false;

  const sender = Object.assign(emitter, {
    id: overrides.id ?? 1,
    sent,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    ...overrides,
  });

  return sender;
}

/**
 * Create a fake ipcMain registry supporting handle / removeHandler / on / invoke.
 */
function createMockIpcMain() {
  const handlers = new Map();
  const listeners = new Map();

  return {
    handlers,
    listeners,
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke: async (channel, event, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
      return handler(event ?? { sender: createMockWebContents() }, ...args);
    },
  };
}

/**
 * Load a CJS module freshly with temporary Module._load overrides and guaranteed restoration.
 */
function loadWithMockedModules(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  const originalLoad = Module._load;
  const previousCache = require.cache[resolved];
  delete require.cache[resolved];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const loaded = require(resolved);
    return {
      exports: loaded,
      restore: () => {
        Module._load = originalLoad;
        if (previousCache) {
          require.cache[resolved] = previousCache;
        } else {
          delete require.cache[resolved];
        }
      },
    };
  } catch (err) {
    Module._load = originalLoad;
    if (previousCache) {
      require.cache[resolved] = previousCache;
    } else {
      delete require.cache[resolved];
    }
    throw err;
  }
}

module.exports = {
  createMockWebContents,
  createMockIpcMain,
  loadWithMockedModules,
};
