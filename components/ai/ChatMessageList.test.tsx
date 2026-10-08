import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { ChatMessage } from "../../infrastructure/ai/types.ts";
import type { ApprovalRequest } from "../../infrastructure/ai/shared/approvalGate.ts";
import ChatMessageList, {
  buildCodexApprovalRenderPlan,
  isSafeCompletedAssistantResponse,
  pruneResolvedApprovals,
  shouldProvideVaultArtifactNavigation,
  shouldRenderAssistantAsPlainText,
} from "./ChatMessageList.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";

const makeMessage = (index: number): ChatMessage => ({
  id: `msg-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message-${index}`,
  timestamp: index,
});

test("resolved approval state retains only tool calls still present in messages", () => {
  const previous = new Map<string, boolean>();
  for (let index = 0; index < 1_000; index += 1) previous.set(`old-${index}`, true);
  previous.set("live-call", false);
  const messages: ChatMessage[] = [{
    id: "assistant-live",
    role: "assistant",
    content: "",
    timestamp: 1,
    toolCalls: [{ id: "live-call", name: "terminal_execute", arguments: {} }],
  }];

  const next = pruneResolvedApprovals(previous, messages);
  assert.deepEqual([...next], [["live-call", false]]);
});

test("assistant content stays plain only when markdown is hidden", () => {
  assert.equal(shouldRenderAssistantAsPlainText({
    hideMarkdown: false,
  }), false);
  assert.equal(shouldRenderAssistantAsPlainText({
    hideMarkdown: true,
  }), true);
});

test("fork action only considers safe completed assistant response boundaries", () => {
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "question", timestamp: 1 },
    { id: "assistant-1", role: "assistant", content: "answer", timestamp: 2, executionStatus: "completed" },
    { id: "user-2", role: "user", content: "follow-up", timestamp: 3 },
    { id: "assistant-2", role: "assistant", content: "working", timestamp: 4, executionStatus: "running" },
  ];

  assert.equal(isSafeCompletedAssistantResponse(messages, 1, false), true);
  assert.equal(isSafeCompletedAssistantResponse(messages, 1, true), false);
  assert.equal(isSafeCompletedAssistantResponse(messages, 3, false), false);
  assert.equal(isSafeCompletedAssistantResponse([
    { ...messages[1], executionStatus: undefined },
  ], 0, false), true);
  assert.equal(isSafeCompletedAssistantResponse([
    { ...messages[1], toolCalls: [{ id: "call-1", name: "terminal_execute", arguments: {} }] },
  ], 0, false), false);
});

test("ChatMessageList shows fork and undo actions only when safe", () => {
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "question", timestamp: 1 },
    { id: "assistant-1", role: "assistant", content: "answer", timestamp: 2, executionStatus: "completed" },
  ];

  const settledMarkup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, {
          messages,
          isStreaming: false,
          onForkAfterTurn: () => {},
          onUndoLastTurn: () => {},
          canUndoLastTurn: true,
        }),
      ),
    ),
  );
  assert.match(settledMarkup, /aria-label="Fork from here"/);
  assert.match(settledMarkup, /aria-label="Undo last turn\.[^"]+"/);

  const streamingMarkup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, {
          messages,
          isStreaming: true,
          onForkAfterTurn: () => {},
          onUndoLastTurn: () => {},
          canUndoLastTurn: true,
        }),
      ),
    ),
  );
  assert.doesNotMatch(streamingMarkup, /Fork from here/);
  assert.doesNotMatch(streamingMarkup, /Undo last turn/);

  const unsafeMarkup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, {
          messages: [
            messages[0],
            { ...messages[1], executionStatus: "failed" },
          ],
          onForkAfterTurn: () => {},
          onUndoLastTurn: () => {},
          canUndoLastTurn: true,
        }),
      ),
    ),
  );
  assert.doesNotMatch(unsafeMarkup, /Fork from here/);
  assert.doesNotMatch(unsafeMarkup, /Undo last turn/);
});

test("ChatMessageList renders Streamdown for the streaming assistant message", () => {
  const messages: ChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "hello",
      timestamp: 1,
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "streaming-body",
      timestamp: 2,
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages, isStreaming: true }),
      ),
    ),
  );

  assert.match(markup, /data-ai-content="markdown"/);
  assert.match(markup, /streaming-body/);
  assert.doesNotMatch(markup, /data-ai-content="plain"/);
});

test("streaming assistant content keeps Streamdown live with isAnimating", () => {
  const source = readFileSync(new URL("./ChatMessageList.tsx", import.meta.url), "utf8");

  assert.match(source, /isAnimating=\{!!isThisStreaming\}/);
  assert.doesNotMatch(source, /isStreaming: !!isThisStreaming/);
});

test("ChatMessageList hydrates markdown after streaming settles", () => {
  const messages: ChatMessage[] = [{
    id: "assistant-1",
    role: "assistant",
    content: "settled-body",
    timestamp: 1,
  }];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages, isStreaming: false }),
      ),
    ),
  );

  assert.match(markup, /data-ai-content="markdown"/);
  assert.match(markup, /settled-body/);
  assert.doesNotMatch(markup, /data-ai-content="plain"/);
});

test("ChatMessageList only renders the recent message batch by default", () => {
  const messages = Array.from({ length: 60 }, (_value, index) => makeMessage(index));

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /Load earlier messages \(10 more\)/);
  assert.doesNotMatch(markup, /message-0/);
  assert.match(markup, /message-10/);
  assert.match(markup, /message-59/);
});

test("ChatMessageList exposes jump navigation once there are enough user turns", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", content: "first turn", timestamp: 1 },
    { id: "a1", role: "assistant", content: "ok", timestamp: 2 },
    { id: "u2", role: "user", content: "second turn", timestamp: 3 },
    { id: "a2", role: "assistant", content: "ok", timestamp: 4 },
    { id: "u3", role: "user", content: "third turn", timestamp: 5 },
    { id: "a3", role: "assistant", content: "ok", timestamp: 6 },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /aria-label="Jump to message"/);
  assert.match(markup, /id="ai-chat-msg-u1"/);
  assert.match(markup, /id="ai-chat-msg-u3"/);
});

test("jump pin release does not reset the loaded message tail", () => {
  const source = readFileSync(new URL("./ChatMessageList.tsx", import.meta.url), "utf8");
  const releaseHandler = source.match(
    /const handleReleaseJumpPin = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/,
  )?.[0] ?? "";

  assert.match(releaseHandler, /setActiveJumpMessageId\(null\)/);
  assert.match(releaseHandler, /setPendingJumpMessageId\(null\)/);
  assert.doesNotMatch(releaseHandler, /setRenderedTailCount/);
});

test("load earlier advances from the effective pinned tail", () => {
  const source = readFileSync(new URL("./ChatMessageList.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /setRenderedTailCount\(\(count\) =>\s*Math\.max\(count, effectiveTailCount\) \+ MESSAGE_RENDER_STEP\)/,
  );
});

test("jump pin ignores streaming isAtBottom flips and releases on scroll button", () => {
  const jumpSource = readFileSync(new URL("./ChatJumpNav.tsx", import.meta.url), "utf8");
  const listSource = readFileSync(new URL("./ChatMessageList.tsx", import.meta.url), "utf8");

  assert.match(jumpSource, /isStreaming\?: boolean/);
  assert.match(jumpSource, /if \(isStreaming\) return;/);
  assert.match(jumpSource, /window\.setTimeout/);
  assert.match(listSource, /isStreaming=\{!!isStreaming\}/);
  assert.match(listSource, /<ConversationScrollButton onClick=\{handleReleaseJumpPin\} \/>/);
});

test("ChatMessageList renders Codex activities and actual usage", () => {
  const messages: ChatMessage[] = [{
    id: "assistant-activity",
    role: "assistant",
    content: "Done",
    timestamp: 1,
    agentActivities: [
      {
        id: "plan-1",
        type: "plan_update",
        status: "running",
        items: [{ text: "Map Codex events", completed: false }],
      },
      {
        id: "search-1",
        type: "web_search",
        status: "completed",
        query: "Codex SDK event types",
      },
      {
        id: "patch-1",
        type: "file_change",
        status: "completed",
        changes: [{ path: "src/app.ts", kind: "update" }],
      },
      {
        id: "warning-1",
        type: "warning",
        status: "completed",
        message: "A recoverable warning",
      },
    ],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
    },
  }];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages, isStreaming: true }),
      ),
    ),
  );

  assert.match(markup, /Agent activity/);
  assert.match(markup, /Map Codex events/);
  assert.match(markup, /Codex SDK event types/);
  assert.match(markup, /src\/app\.ts/);
  assert.match(markup, /A recoverable warning/);
  assert.match(markup, /Tokens 125/);
  assert.match(markup, /cached 40/);
  assert.match(markup, /reasoning 10/);
});

test("ChatMessageList renders external MCP vault tool results as artifact cards", () => {
  const messages: ChatMessage[] = [
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 1,
      toolResults: [
        {
          toolCallId: "external-call-1",
          toolName: "mcp__netcatty__vault_notes_create",
          content: JSON.stringify({
            ok: true,
            note: { id: "note-1", title: "Deploy Runbook", group: "ops" },
          }),
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /Deploy Runbook/);
  assert.match(markup, /ops/);
  assert.doesNotMatch(markup, /external-call-1/);
});

test("ChatMessageList renders Netcatty CLI vault results as artifact cards", () => {
  const messages: ChatMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      toolCalls: [
        {
          id: "cli-call-1",
          name: "shell",
          arguments: {
            command: `/bin/zsh -lc '"/Applications/Netcatty.app/netcatty-tool-cli" vault host get --host-id host_1 --json'`,
          },
        },
      ],
      executionStatus: "completed",
    },
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 2,
      toolResults: [
        {
          toolCallId: "cli-call-1",
          toolName: "shell",
          content: JSON.stringify({
            ok: true,
            host: { id: "host_1", label: "Prod", hostname: "prod.example.com", port: 22 },
          }),
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /Prod/);
  assert.match(markup, /prod\.example\.com:22/);
  assert.doesNotMatch(markup, /cli-call-1/);
});

test("ChatMessageList renders Claude MCP list envelopes as summary cards", () => {
  const messages: ChatMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      toolCalls: [
        {
          id: "notes-call-1",
          name: "mcp__netcatty-remote-hosts__vault_notes_list",
          arguments: {},
        },
      ],
      executionStatus: "completed",
    },
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 2,
      toolResults: [
        {
          toolCallId: "notes-call-1",
          content: JSON.stringify([
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                notes: Array.from({ length: 8 }, (_value, index) => ({
                  id: `note-${index}`,
                  title: `Note ${index}`,
                })),
              }),
            },
          ]),
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /8 notes in Vault/);
  assert.doesNotMatch(markup, /notes-call-1/);
});

test("ChatMessageList renders OpenCode MCP-prefixed vault results as artifact cards", () => {
  const messages: ChatMessage[] = [
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 1,
      toolResults: [
        {
          toolCallId: "opencode-call-1",
          toolName: "netcatty-remote-hosts_vault_notes_get",
          content: JSON.stringify({
            ok: true,
            note: {
              id: "note-1",
              title: "2026-06-25 Host Import Report",
              group: "infra/imports",
            },
          }),
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /2026-06-25 Host Import Report/);
  assert.match(markup, /infra\/imports/);
  assert.doesNotMatch(markup, /opencode-call-1/);
});

test("ChatMessageList renders Copilot MCP-prefixed wrapped vault results as artifact cards", () => {
  const payload = {
    ok: true,
    notes: Array.from({ length: 8 }, (_value, index) => ({
      id: `note-${index}`,
      title: `Note ${index}`,
    })),
  };
  const messages: ChatMessage[] = [
    {
      id: "tool-1",
      role: "tool",
      content: "",
      timestamp: 1,
      toolResults: [
        {
          toolCallId: "copilot-call-1",
          toolName: "netcatty-remote-hosts-vault_notes_list",
          content: JSON.stringify({
            content: JSON.stringify(payload),
            detailedContent: JSON.stringify(payload),
            contents: [
              {
                type: "text",
                text: JSON.stringify(payload),
              },
            ],
          }),
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /8 notes in Vault/);
  assert.doesNotMatch(markup, /copilot-call-1/);
});

test('ChatMessageList renders script create tool results as artifact cards', () => {
  const messages: ChatMessage[] = [
    {
      id: 'tool-script-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolResults: [
        {
          toolCallId: 'call-script-1',
          toolName: 'scripts_create',
          content: {
            ok: true,
            script: {
              id: 'script-1',
              label: 'Disk cleanup',
              language: 'javascript',
            },
          },
        },
      ],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ChatMessageList, { messages }),
      ),
    ),
  );

  assert.match(markup, /Disk cleanup/);
  assert.match(markup, /javascript script/);
  assert.doesNotMatch(markup, /call-script-1/);
});

test("ChatMessageList wires vault artifact navigation when only note open is available", () => {
  assert.equal(shouldProvideVaultArtifactNavigation({
    onOpenVaultNote: () => {},
  }), true);
});

test("ChatMessageList leaves vault artifact navigation disabled without open actions", () => {
  assert.equal(shouldProvideVaultArtifactNavigation({}), false);
});

test("Codex approval render plan preserves every approval for the same item", () => {
  const codexRequest = (
    toolCallId: string,
    itemId: string,
    command: string,
    chatSessionId = "chat-1",
  ): ApprovalRequest => ({
    toolCallId,
    itemId,
    toolName: "codex.command",
    args: { command },
    chatSessionId,
    source: "codex-app-server",
    approvalType: "command",
    allowSession: false,
  });
  const pendingApprovals = new Map<string, ApprovalRequest>([
    ["approval-1", codexRequest("approval-1", "item-1", "echo one")],
    ["approval-2", codexRequest("approval-2", "item-1", "echo two")],
    ["approval-3", codexRequest("approval-3", "item-2", "echo standalone")],
    ["approval-other-session", codexRequest("approval-other-session", "item-1", "echo hidden", "chat-2")],
    ["regular-approval", {
      toolCallId: "regular-approval",
      toolName: "terminal_execute",
      args: { command: "pwd" },
      chatSessionId: "chat-1",
    }],
  ]);

  const plan = buildCodexApprovalRenderPlan(
    pendingApprovals,
    new Set(["item-1"]),
    "chat-1",
  );

  assert.deepEqual(
    plan.byItemId.get("item-1")?.map(({ approvalId }) => approvalId),
    ["approval-1", "approval-2"],
  );
  assert.deepEqual(
    plan.standalone.map(({ approvalId }) => approvalId),
    ["approval-3"],
  );
});
