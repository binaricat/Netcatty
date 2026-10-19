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

for (const field of ["attachments", "images"] as const) {
  test(`ChatMessageList shows unavailable restored ${field} without broken image previews`, () => {
    const messages: ChatMessage[] = [{
      id: "restored-user", role: "user", content: "restored request", timestamp: 1,
      [field]: [
        { base64Data: "", contentUnavailable: true, mediaType: "image/png", filename: "screenshot.png" },
        { base64Data: "", contentUnavailable: true, mediaType: "application/pdf", filename: "report.pdf" },
        { base64Data: "", contentUnavailable: true, mediaType: "text/plain", filename: "selection.log", terminalSelection: true },
      ],
    }];
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <TooltipProvider><ChatMessageList messages={messages} /></TooltipProvider>
      </I18nProvider>,
    );
    assert.match(markup, /screenshot\.png/);
    assert.match(markup, /report\.pdf/);
    assert.match(markup, /selection\.log/);
    assert.match(markup, /Content not available on this device/);
    assert.doesNotMatch(markup, /<img|data:image/);
  });
}

test("ChatMessageList retains local image previews and synced note identities", () => {
  const messages: ChatMessage[] = [{
    id: "user", role: "user", content: "look", timestamp: 1,
    attachments: [
      { base64Data: "cGljdHVyZQ==", mediaType: "image/png", filename: "local.png" },
      { base64Data: "", contentUnavailable: true, mediaType: "text/markdown", vaultNoteId: "note-1", vaultNoteTitle: "Runbook" },
    ],
  }];
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider><ChatMessageList messages={messages} /></TooltipProvider>
    </I18nProvider>,
  );
  assert.match(markup, /<img/);
  assert.match(markup, /data:image\/png;base64,cGljdHVyZQ==/);
  assert.match(markup, /Runbook/);
  assert.doesNotMatch(markup, /Content not available on this device/);
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

test('fork is offered only for safe completed replies and hidden while streaming', () => {
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'hello', timestamp: 1 },
    { id: 'done', role: 'assistant', content: 'completed', timestamp: 2, executionStatus: 'completed' },
    { id: 'failed', role: 'assistant', content: 'failed', timestamp: 3, executionStatus: 'failed' },
  ];
  const render = (isStreaming: boolean) => renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ChatMessageList messages={messages} isStreaming={isStreaming} onForkFromMessage={() => {}} />
      </TooltipProvider>
    </I18nProvider>,
  );
  assert.equal((render(false).match(/Fork from here/g) ?? []).length, 1);
  assert.equal((render(true).match(/Fork from here/g) ?? []).length, 0);
});
