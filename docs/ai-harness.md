# Netcatty AI Harness Architecture

This document describes the current Netcatty AI harness, its boundaries, and
the direction for future consolidation. It is intentionally factual: it
documents what exists today and separates that from roadmap items.

## Summary

Netcatty has two AI execution paths:

1. **Catty, the built-in agent.** The renderer drives a Vercel AI SDK
   `streamText` turn with Netcatty tools, context compaction, retry handling,
   and UI streaming state in `components/ai/hooks/useAIChatStreaming.ts`.
2. **Managed external agents.** Electron main runs official or vendor SDK
   drivers for Claude, Codex, Copilot, Cursor, CodeBuddy, and OpenCode under
   `electron/bridges/aiBridge/sdk/*`. Netcatty injects its capabilities through
   the Netcatty MCP server or through Skills + `netcatty-tool-cli`.

The harness already has production-grade pieces: Electron main process key
custody, scoped Netcatty terminal execution, MCP/Skills integration,
observer/confirm/autonomous permission modes, approval gates, context
compaction, 413 retry handling, and real terminal/SSH/Serial/SFTP surfaces.

The important limitation is that these pieces are not yet a single unified
agent runtime. Catty, managed SDK agents, MCP, Skills, capability catalog,
history, compaction, and trace events are still partly separate surfaces.

## Runtime paths

### Built-in Catty path

Catty is a Netcatty-owned chat path in the renderer:

- `useAIChatStreaming.ts` builds the prompt, messages, tools, abort state, and
  per-session streaming UI state.
- `createModelFromConfig` maps configured providers to Vercel AI SDK clients.
  Providers are modeled by protocol style (`openai`, `anthropic`, `google`)
  rather than by a legacy single "Gemini service" abstraction.
- `createCattyTools` defines Vercel AI SDK tools with zod schemas.
- `streamText` executes the model/tool loop for the built-in agent, with
  `stepCountIs(maxIterations)` applying to this path.

Current Catty tools include:

- `terminal_execute`
- `workspace_get_info`
- `workspace_get_session_info`
- `web_search` when web search is configured
- `url_fetch`

Catty does not yet have parity with every Netcatty MCP/capability operation.
For example, long-running terminal `start/poll/stop` tools and SFTP operations
are available or planned on other surfaces, but are not currently Catty tools.

### Managed external SDK path

Managed external agents run in the Electron main process:

- Renderer code calls `runSdkAgentTurn` in `infrastructure/ai/sdkAgentAdapter.ts`.
- The preload bridge forwards the request to `aiBridge`.
- `electron/bridges/aiBridge/sdk/index.cjs` dispatches to a backend driver for
  Claude, Codex, Copilot, Cursor, CodeBuddy, or OpenCode.
- Drivers stream normalized events back to the renderer for UI display.

These backends own their vendor-specific agent loops. Netcatty can inject
tools, scope, environment, and cancellation, but it cannot uniformly enforce
all internal vendor loop controls such as exact step limits, compaction policy,
or cost accounting inside every SDK.

### MCP and Skills integration

External agents can access Netcatty in two integration modes:

- **MCP mode.** `electron/mcp/netcatty-mcp-server.cjs` is injected as a stdio
  MCP server. It connects back to the Netcatty main process over localhost TCP
  with a per-host token and scoped chat/session metadata.
- **Skills + CLI mode.** Netcatty starts the same control host and writes the
  discovery data used by `netcatty-tool-cli`; the agent receives skill
  instructions and invokes the CLI instead of an injected MCP server.

The current MCP server exposes:

- `get_environment`
- `list_attachments`
- `read_attachment`
- `terminal_execute`
- `terminal_start`
- `terminal_poll`
- `terminal_stop`

Skills documentation for the CLI lives in `skills/netcatty-tool-cli/`.

## Capability catalog

`electron/capabilities/*` defines a shared capability catalog and policy layer
covering terminal, SFTP, vault, port forwarding, and metadata capabilities. The
catalog is the intended source for tool metadata, permission policy, RPC
methods, and public/internal surfaces.

Current state:

- Capability definitions and policy checks exist.
- Built-in and public surfaces can evaluate write/read sensitivity and confirm
  requirements.
- Some tool surfaces are still hand-written. For example, Catty tools and the
  injected MCP server are not yet fully generated from the catalog.

Direction:

- Treat the catalog as the future `CapabilityRegistry`.
- Generate or derive Catty tools, MCP tools, CLI commands, timeouts, permission
  policy, and UI metadata from the same definitions.
- Remove drift between Catty, MCP, Skills, CLI, and direct IPC capability
  exposure.

## Permission and safety boundaries

Netcatty uses several layers of safety and policy, but they should not be
described as a complete sandbox or complete security boundary.

Current layers include:

- Provider credentials are kept behind Electron main/preload boundaries; the
  renderer should not directly handle raw provider secrets.
- Netcatty scopes tool access to chat sessions and exposed terminal sessions.
- Permission modes are:
  - `observer`: write operations are blocked.
  - `confirm`: write/sensitive operations request user approval.
  - `autonomous`: approved capability surfaces can execute without per-call
    confirmation.
- The capability policy layer can mark operations as writes, sensitive reads,
  approval-required, or observer-blocked.
- The MCP server authenticates to the local TCP bridge with a generated token
  and passes chat/session scope.
- Terminal execution has queueing/mutex behavior to avoid racing commands in a
  single target session.
- Command blocklists are applied as defense-in-depth for shell-like command
  surfaces.

Important wording:

- The command blocklist is **defense-in-depth**, not the full security boundary.
- Permission mode, capability policy, scoped sessions, approval gates, process
  isolation, local bridge authentication, and backend-specific SDK behavior all
  contribute to the actual operational boundary.
- External SDK agents run their own loops. Netcatty should not claim uniform
  control over every vendor-internal step unless that backend exposes such
  controls and Netcatty enforces them.
- Internal Netcatty integration surfaces such as `electron/cli/*`,
  `netcatty-tool-cli`, discovery files, and the local TCP bridge are not public
  third-party APIs unless explicitly documented as such.

## Context compaction

Catty currently has Netcatty-owned context management:

- `infrastructure/ai/contextCompaction.ts` estimates tokens as `chars / 4`.
- The default context window is 128k tokens unless overridden by provider or
  discovered model metadata.
- Compaction triggers around 85% of the resolved context window.
- Recent messages are protected.
- Tool-call/tool-result boundaries are protected when choosing a split point.
- Old messages are summarized by an LLM prompt that preserves goals, commands,
  paths, errors, results, decisions, constraints, and open tasks.
- Reasoning blocks are pruned where supported.
- HTTP 413 errors trigger a forced compaction and one retry, with an additional
  request payload compression fallback for oversized content.

Known limitations:

- Token accounting is approximate and not provider-tokenizer exact.
- Tool results are not yet compressed by typed result semantics.
- Large terminal output does not yet have reusable handles or replayable
  references.
- Compaction events are not yet recorded in a unified trace store.
- Managed external agents may apply their own history and compaction rules that
  Netcatty can observe only indirectly.

## Why Vercel AI SDK is not the whole agent runtime

Vercel AI SDK is useful in Netcatty because it provides provider adapters,
streaming primitives, tool schemas, and a model/tool loop for Catty. It is a
good model invocation and tool-loop layer.

It is not, by itself, Netcatty's complete product-grade agent runtime because a
desktop SSH/SFTP/terminal agent also needs:

- cross-backend event normalization
- shared session history across built-in and managed agents
- capability registration across Catty, MCP, Skills, CLI, and IPC
- permission policy and approval UX
- scoped terminal/SSH/Serial/SFTP execution
- context compaction and traceability
- cancellation, long-running jobs, output budgeting, and loop guards
- debug export and replay across backends

Netcatty should therefore treat Vercel AI SDK as one backend/layer inside the
harness, not as the full architecture boundary.

## Known gaps and roadmap

The main architectural gap is the lack of one Netcatty-owned runtime contract
that every backend maps into. A target shape is:

```text
UI / CLI / future API
  -> AgentRuntime
    -> ProviderBackend (Vercel / Claude SDK / Codex / Pi / OpenCode / others)
    -> CapabilityRegistry
    -> ContextManager
    -> PermissionPolicy
    -> TraceStore
```

Recommended next steps:

1. **Define `AgentEvent`.** Normalize turn start/end, model deltas, tool calls,
   tool results, approvals, compaction, usage, errors, and cancellation.
2. **Converge on `CapabilityRegistry`.** Derive Catty tools, MCP tools, CLI
   commands, timeouts, UI metadata, and permission checks from one catalog.
3. **Improve context engineering.** Add provider-aware token accounting, typed
   tool-output compression, terminal output handles, deduplication notices,
   compaction traces, and post-compaction reinjection of session/safety scope.
4. **Close tool parity gaps.** Add Catty long-running terminal tools and align
   SFTP capability exposure across Catty, MCP, Skills, and public surfaces.
5. **Add loop and cost controls.** Track per-turn tool calls, repeated failures,
   output budgets, token/cost soft limits, and backend-specific hard guards
   where available.
6. **Evaluate Pi SDK as a backend, not a replacement.** A Pi integration should
   start as a managed backend/POC through subprocess or RPC, only expose
   Netcatty capabilities, and map Pi events into the same `AgentEvent` contract.

## Public positioning

Use this wording when explaining Netcatty externally:

- Netcatty includes a built-in Catty agent and managed external agent
  integrations.
- Catty uses Vercel AI SDK for provider streaming and tool-loop execution.
- Managed external agents run through their own SDK drivers and receive
  Netcatty capabilities through MCP or Skills + CLI.
- Netcatty has meaningful safety layers, but the command blocklist is only
  defense-in-depth.
- Netcatty is moving toward a unified AgentRuntime, CapabilityRegistry,
  ContextManager, PermissionPolicy, and TraceStore rather than claiming those
  are fully consolidated today.
