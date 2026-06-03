"use strict";

/**
 * Env construction for SDK agent subprocesses.
 *
 * Consolidates the env hardening that previously lived in
 * agentProcessHandlers.cjs (DANGEROUS_ENV_KEYS) and the per-spawn merge in
 * acpHandlers.cjs (withCliDiscoveryEnv + normalizeClaudeCodeExecutableEnvForAcp).
 * Callers inject the netcatty helpers so this module stays pure/testable.
 */

// Env var names that can be used for code injection into a child process.
// Mirror of the set in the (now-removed) raw agent spawn handler.
const DANGEROUS_ENV_KEYS = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
  "PYTHONPATH", "RUBYLIB", "PERL5LIB",
  "BASH_ENV", "ENV", "CDPATH", "PROMPT_COMMAND",
]);

function isDangerousEnvKey(key) {
  return DANGEROUS_ENV_KEYS.has(key) || String(key).startsWith("BASH_FUNC_");
}

/**
 * Build the env handed to an SDK agent subprocess.
 *
 * @param {object}  args
 * @param {Record<string,string>} args.shellEnv            Resolved shell env (PATH-augmented).
 * @param {Record<string,string>} [args.requestedAgentEnv] Per-agent env from the UI (filtered).
 * @param {(e:Record<string,string>)=>Record<string,string>} [args.withCliDiscoveryEnv]
 *        netcatty helper that injects the tool-CLI discovery file path.
 * @param {(e:Record<string,string>)=>Record<string,string>} [args.normalizeClaudeCodeExecutableEnv]
 *        netcatty helper that rewrites CLAUDE_CODE_EXECUTABLE to a runnable path (claude only).
 * @returns {Record<string,string>}
 */
function buildSdkAgentEnv({
  shellEnv,
  requestedAgentEnv,
  withCliDiscoveryEnv,
  normalizeClaudeCodeExecutableEnv,
}) {
  const filteredRequested = {};
  if (requestedAgentEnv && typeof requestedAgentEnv === "object") {
    for (const [k, v] of Object.entries(requestedAgentEnv)) {
      if (typeof v === "string" && !isDangerousEnvKey(k)) {
        filteredRequested[k] = v;
      }
    }
  }

  let env = { ...shellEnv, ...filteredRequested };
  if (typeof withCliDiscoveryEnv === "function") {
    env = withCliDiscoveryEnv(env);
  }
  if (typeof normalizeClaudeCodeExecutableEnv === "function") {
    env = normalizeClaudeCodeExecutableEnv(env);
  }
  return env;
}

module.exports = { buildSdkAgentEnv, DANGEROUS_ENV_KEYS, isDangerousEnvKey };
