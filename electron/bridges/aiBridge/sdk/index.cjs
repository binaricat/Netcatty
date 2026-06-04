"use strict";

/**
 * SDK driver registry. Mirrors craft backend/factory.ts DRIVER_REGISTRY.
 * Each driver exposes a uniform runTurn(ctx) that builds its SDK options from
 * the neutral context and streams events through ctx.emitter.
 *
 * ctx shape (built by sdkStreamHandlers.cjs):
 *   { prompt, attachments, cwd, model, env, binPath, injectedMcpServers, emitter,
 *     signal, resumeSessionId, apiKey, baseUrl }
 */
const claude = require("./claudeDriver.cjs");
const codex = require("./codexDriver.cjs");
const copilot = require("./copilotDriver.cjs");

const DRIVER_REGISTRY = {
  claude: {
    async runTurn(ctx) {
      const options = claude.buildClaudeQueryOptions({
        cwd: ctx.cwd,
        model: ctx.model,
        env: ctx.env,
        pathToClaudeCodeExecutable: ctx.binPath,
        abortController: ctx.abortController,
        injectedMcpServers: ctx.injectedMcpServers,
        settings: ctx.claudeSettings,
        resume: ctx.resumeSessionId,
        toolIntegrationMode: ctx.toolIntegrationMode,
      });
      return claude.runClaudeTurn({ prompt: ctx.prompt, attachments: ctx.attachments, options, emitter: ctx.emitter });
    },
    async listModels(ctx) {
      return claude.listClaudeModels({ pathToClaudeCodeExecutable: ctx.binPath, env: ctx.env });
    },
  },
  codex: {
    async runTurn(ctx) {
      const constructorOptions = codex.buildCodexConstructorOptions({
        codexPath: ctx.binPath,
        env: ctx.env,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        injectedMcpServers: ctx.injectedMcpServers,
      });
      const threadOptions = codex.buildCodexThreadOptions({ cwd: ctx.cwd, model: ctx.model });
      return codex.runCodexTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        constructorOptions,
        threadOptions,
        resumeThreadId: ctx.resumeSessionId,
        emitter: ctx.emitter,
        signal: ctx.signal,
      });
    },
    // codex-sdk exposes no model catalog; the UI falls back to curated presets.
    async listModels() { return []; },
  },
  copilot: {
    async runTurn(ctx) {
      const clientOptions = copilot.buildCopilotClientOptions({ cliPath: ctx.binPath });
      const sessionOptions = copilot.buildCopilotSessionOptions({
        model: ctx.model,
        injectedMcpServers: ctx.injectedMcpServers,
      });
      return copilot.runCopilotTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        clientOptions,
        sessionOptions,
        resumeSessionId: ctx.resumeSessionId,
        emitter: ctx.emitter,
        signal: ctx.signal,
      });
    },
    async listModels(ctx) {
      return copilot.listCopilotModels({ cliPath: ctx.binPath });
    },
  },
};

function getDriver(backend) {
  const driver = DRIVER_REGISTRY[backend];
  if (!driver) throw new Error(`No SDK driver registered for backend: ${backend}`);
  return driver;
}

function listBackends() {
  return Object.keys(DRIVER_REGISTRY);
}

module.exports = { DRIVER_REGISTRY, getDriver, listBackends };
