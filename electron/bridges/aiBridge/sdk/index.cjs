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
const cursor = require("./cursorDriver.cjs");
const cursorCli = require("./cursorCliDriver.cjs");
const codebuddy = require("./codebuddyDriver.cjs");
const opencode = require("./opencodeDriver.cjs");
const grok = require("./grokDriver.cjs");
const grokAcp = require("./grokAcpDriver.cjs");
const { codebuddySessionManager } = require("./codebuddySessionManager.cjs");

function hasCodebuddyQueryOnlyOptions(options) {
  return Boolean(
    options.maxBudgetUsd ||
    options.sandbox?.enabled === true ||
    options.fallbackModel ||
    options.enableFileCheckpointing === true ||
    options.outputFormat,
  );
}

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
      return claude.listClaudeModels({
        pathToClaudeCodeExecutable: ctx.binPath,
        env: ctx.env,
        abortController: ctx.abortController,
        signal: ctx.signal,
      });
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
        toolIntegrationMode: ctx.toolIntegrationMode,
      });
      return copilot.runCopilotTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        clientOptions,
        sessionOptions,
        resumeSessionId: ctx.resumeSessionId,
        toolIntegrationMode: ctx.toolIntegrationMode,
        runtimeEnv: ctx.env,
        emitter: ctx.emitter,
        signal: ctx.signal,
      });
    },
    async listModels(ctx) {
      return copilot.listCopilotModels({
        cliPath: ctx.binPath,
        abortController: ctx.abortController,
        signal: ctx.signal,
      });
    },
  },
  cursor: {
    async runTurn(ctx) {
      const authMode = ctx.cursorAuthMode === "cli-login" ? "cli-login" : "api-key";
      if (authMode === "cli-login") {
        return cursorCli.runCursorCliTurn({
          prompt: ctx.prompt,
          binPath: ctx.cursorCliBinPath || ctx.binPath,
          cwd: ctx.cwd,
          chatSessionId: ctx.chatSessionId,
          getTempDir: ctx.getTempDir,
          model: ctx.model,
          env: ctx.env,
          permissionMode: ctx.permissionMode,
          resumeSessionId: ctx.resumeSessionId,
          injectedMcpServers: ctx.injectedMcpServers,
          emitter: ctx.emitter,
          signal: ctx.signal,
        });
      }
      const agentOptions = cursor.buildCursorAgentOptions({
        apiKey: ctx.apiKey,
        env: ctx.env,
        model: ctx.model,
        cwd: ctx.cwd,
        injectedMcpServers: ctx.injectedMcpServers,
      });
      return cursor.runCursorTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        agentOptions,
        runtimeEnv: ctx.env,
        resumeSessionId: ctx.resumeSessionId,
        emitter: ctx.emitter,
        signal: ctx.signal,
      });
    },
    async listModels(ctx) {
      if (ctx.cursorAuthMode === "cli-login") {
        return cursorCli.listCursorCliModels({
          binPath: ctx.cursorCliBinPath || ctx.binPath,
          env: ctx.env,
          abortController: ctx.abortController,
          signal: ctx.signal,
        });
      }
      return cursor.listCursorModels({
        env: ctx.env,
        abortController: ctx.abortController,
        signal: ctx.signal,
      });
    },
  },
  codebuddy: {
    async runTurn(ctx) {
      // Build the permission handler: when the CLI hits a security restriction,
      // auto-confirm (auto mode) or prompt the user (confirm mode) instead of
      // throwing an error.
      const canUseTool = codebuddy.buildCodebuddyCanUseTool({
        permissionMode: ctx.permissionMode,
        chatSessionId: ctx.chatSessionId,
        requestApproval: ctx.requestApprovalFromRenderer,
      });
      // Build the elicitation handler: forwards create/complete events to the
      // renderer and waits for the user's decision via the session manager's
      // pending-response map (resolved by the elicitation-response IPC).
      // chatSessionId lets closeForChat cancel pendings when the chat closes.
      const elicitation = codebuddy.buildCodebuddyElicitation(
        ctx.emitter,
        codebuddySessionManager.elicitationPending,
        { chatSessionId: ctx.chatSessionId },
      );
      const options = codebuddy.buildCodebuddyQueryOptions({
        cwd: ctx.cwd,
        model: ctx.model,
        env: ctx.env,
        injectedMcpServers: ctx.injectedMcpServers,
        abortController: ctx.abortController,
        resume: ctx.resumeSessionId,
        pathToCodebuddyCode: ctx.binPath,
        toolIntegrationMode: ctx.toolIntegrationMode,
        // SDK 0.3.230 options
        systemPrompt: ctx.systemPrompt,
        effort: ctx.effort,
        maxTurns: ctx.maxTurns,
        maxBudgetUsd: ctx.maxBudgetUsd,
        fallbackModel: ctx.fallbackModel,
        sandbox: ctx.sandbox,
        agents: ctx.agents,
        outputFormat: ctx.outputFormat,
        enableFileCheckpointing: ctx.enableFileCheckpointing,
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
        hooks: codebuddy.buildCodebuddyHooks(ctx.emitter, {
          toolIntegrationMode: ctx.toolIntegrationMode,
          additionalHooks: ctx.hooks,
          allowedCliCommandPrefix: ctx.skillsCliCommandPrefix,
        }),
        elicitation,
        canUseTool,
      });

      const sessionKey = [
        String(ctx.chatSessionId || ""),
        "codebuddy",
        String(ctx.binPath || ""),
        "sdk",
      ].join("\u0000");

      // Try V2 Session API first (persistent multi-turn), falling back to
      // query() only for fields that SessionOptions does not support.
      const hasQueryOnlyOptions = hasCodebuddyQueryOnlyOptions(options);

      if (!hasQueryOnlyOptions) {
        const sessionOptions = {
          cwd: options.cwd,
          model: options.model,
          env: options.env,
          pathToCodebuddyCode: options.pathToCodebuddyCode,
          mcpServers: options.mcpServers,
          permissionMode: options.permissionMode,
          extraArgs: options.extraArgs,
          systemPrompt: options.systemPrompt,
          hooks: options.hooks,
          elicitation: options.elicitation,
          canUseTool: options.canUseTool,
          includePartialMessages: true,
          tools: options.tools,
          disallowedTools: options.disallowedTools,
          settingSources: options.settingSources,
          maxTurns: options.maxTurns,
          agents: options.agents,
          thinking: options.thinking,
          effort: options.effort,
        };
        const v2Result = await codebuddySessionManager.runTurn({
          sessionKey,
          prompt: ctx.prompt,
          attachments: ctx.attachments,
          options,
          emitter: ctx.emitter,
          sessionOptions,
          resumeSessionId: ctx.resumeSessionId,
        });
        if (v2Result) return v2Result;
      } else {
        // Do not leave a warm V2 process with stale context while query() is
        // resuming and advancing the same persisted conversation.
        codebuddySessionManager.closeSession(sessionKey);
      }

      // Fallback: legacy query() per-turn (supports all Options fields).
      return codebuddy.runCodebuddyTurn({
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        options,
        emitter: ctx.emitter,
      });
    },
    async steerTurn(ctx) {
      const sessionKey = [
        String(ctx.chatSessionId || ""),
        "codebuddy",
        String(ctx.binPath || ""),
        "sdk",
      ].join("\u0000");
      return codebuddySessionManager.steer({
        sessionKey,
        prompt: ctx.prompt,
        attachments: ctx.attachments,
      });
    },
    async listModels(ctx) {
      return codebuddy.listCodebuddyModels({
        pathToCodebuddyCode: ctx.binPath,
        env: ctx.env,
        abortController: ctx.abortController,
        signal: ctx.signal,
      });
    },
  },
  opencode: {
    async runTurn(ctx) {
      return opencode.runOpenCodeTurn({
        prompt: ctx.prompt,
        systemPrompt: ctx.systemPrompt,
        attachments: ctx.attachments,
        cwd: ctx.cwd,
        model: ctx.model,
        env: ctx.env,
        binPath: ctx.binPath,
        injectedMcpServers: ctx.injectedMcpServers,
        toolIntegrationMode: ctx.toolIntegrationMode,
        skillsPathAllowlist: ctx.skillsPathAllowlist,
        resumeSessionId: ctx.resumeSessionId,
        emitter: ctx.emitter,
        abortController: ctx.abortController,
      });
    },
    async listModels(ctx) {
      return opencode.listOpenCodeModels({
        env: ctx.env,
        binPath: ctx.binPath,
        abortController: ctx.abortController,
        signal: ctx.abortController?.signal || ctx.signal,
      });
    },
  },
  grok: {
    async runTurn(ctx) {
      // Default: ACP (`grok agent stdio`) with session-level mcpServers.
      // Explicit fallback: NETCATTY_GROK_RUNTIME=streaming-json or ctx.grokRuntime.
      const runtime = String(
        ctx.grokRuntime
        || ctx.env?.NETCATTY_GROK_RUNTIME
        || process.env.NETCATTY_GROK_RUNTIME
        || "acp",
      ).toLowerCase();
      if (runtime === "streaming-json" || runtime === "cli" || runtime === "headless") {
        // Headless cannot know if -r restored history before the prompt is sent.
        // Prefer native -r without seed (common success path). Stale-id fallback
        // is handled on ACP (default runtime) via historySeed + session/new.
        return grok.runGrokTurn({
          prompt: ctx.prompt,
          binPath: ctx.binPath,
          cwd: ctx.cwd,
          model: ctx.model,
          env: ctx.env,
          permissionMode: ctx.permissionMode,
          toolIntegrationMode: ctx.toolIntegrationMode,
          resumeSessionId: ctx.resumeSessionId,
          injectedMcpServers: ctx.injectedMcpServers,
          emitter: ctx.emitter,
          signal: ctx.signal || ctx.abortController?.signal,
        });
      }
      return grokAcp.runGrokAcpTurn({
        prompt: ctx.prompt,
        systemPrompt: ctx.systemPrompt,
        binPath: ctx.binPath,
        cwd: ctx.cwd,
        model: ctx.model,
        env: ctx.env,
        permissionMode: ctx.permissionMode,
        toolIntegrationMode: ctx.toolIntegrationMode,
        resumeSessionId: ctx.resumeSessionId,
        historySeed: ctx.historySeed,
        injectedMcpServers: ctx.injectedMcpServers,
        emitter: ctx.emitter,
        signal: ctx.signal || ctx.abortController?.signal,
      });
    },
    async listModels(ctx) {
      const acpCatalog = await grokAcp.listGrokAcpModels({
        binPath: ctx.binPath,
        env: ctx.env,
        abortController: ctx.abortController,
        signal: ctx.signal || ctx.abortController?.signal,
      });
      if (acpCatalog.models.length > 0) {
        return acpCatalog;
      }
      const fallbackCatalog = await grok.listGrokModels({
        binPath: ctx.binPath,
        env: ctx.env,
        abortController: ctx.abortController,
        signal: ctx.signal || ctx.abortController?.signal,
      });
      const currentModelId = acpCatalog.currentModelId || fallbackCatalog.currentModelId;
      const models = fallbackCatalog.models.length > 0
        ? fallbackCatalog.models
        : (currentModelId
          ? [grok.applyGrokReasoningFallback({ id: currentModelId, name: currentModelId })]
          : []);
      return {
        currentModelId: grok.resolveGrokCatalogCurrentModelId(models, currentModelId),
        models,
      };
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

module.exports = {
  DRIVER_REGISTRY,
  getDriver,
  listBackends,
  hasCodebuddyQueryOnlyOptions,
};
