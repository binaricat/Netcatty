"use strict";

/**
 * Cursor local agents inherit the host process environment (no local.envVars
 * API). OpenCode's createOpencode likewise spawns from process.env. Concurrent
 * Skills turns in different chats must not overlap those mutations, or a child
 * can inherit another chat's NETCATTY_CLI_CHAT_SESSION_ID and the main process
 * can retain a stale tenant after restore.
 */

let exclusiveChain = Promise.resolve();

function applyTemporaryProcessEnv(env) {
  if (!env || typeof env !== "object") return () => {};
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function withExclusiveProcessEnv(env, fn) {
  const run = exclusiveChain.then(async () => {
    const restore = applyTemporaryProcessEnv(env);
    try {
      return await fn();
    } finally {
      restore();
    }
  });
  exclusiveChain = run.then(() => {}, () => {});
  return run;
}

async function withTemporaryProcessEnv(env, fn) {
  return withExclusiveProcessEnv(env, fn);
}

module.exports = {
  applyTemporaryProcessEnv,
  withExclusiveProcessEnv,
  withTemporaryProcessEnv,
};
