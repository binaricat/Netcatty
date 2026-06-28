/**
 * ChatMessageList - Renders the list of chat messages
 *
 * Claude-Code-style: user messages in bordered bubbles (right-aligned),
 * assistant responses as plain text (left-aligned, no border/bg).
 * No avatars. Thinking blocks are collapsible.
 */

import { AlertCircle, FileText, RotateCcw, SquareTerminal, X, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { ChatMessage } from '../../infrastructure/ai/types';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../ai-elements/message';
import { ToolCall } from '../ai-elements/tool-call';
import ThinkingBlock from './ThinkingBlock';
import ToolCallGroup from './ToolCallGroup';
import {
  VaultArtifactNavigationProvider,
  type VaultArtifactNavSection,
} from './toolArtifacts/VaultArtifactNavigationContext';
import { parseTerminalToolArtifact } from './toolArtifacts/terminalToolArtifact';
import { TerminalArtifactToolResult } from './toolArtifacts/TerminalArtifactToolResult';
import {
  inferArtifactToolNameFromCliArgs,
  normalizeArtifactToolName,
} from './toolArtifacts/toolArtifactNames';
import { parseVaultToolArtifact } from './toolArtifacts/vaultToolArtifact';
import { VaultArtifactToolResult } from './toolArtifacts/VaultArtifactToolResult';
import type { Host, Snippet, VaultNote } from '../../types';
import {
  onApprovalRequest,
  onApprovalCleared,
  replayPendingApprovals,
  resolveApproval,
  type ApprovalRequest,
} from '../../infrastructure/ai/shared/approvalGate';
import {
  buildGrantsFromApproval,
  resolveCapabilityId,
} from '../../infrastructure/ai/harness/permissionGrants';
import {
  compactionStatusText,
  resolveCompactionStatusText,
  type ActiveCompactionUi,
} from './hooks/useAgentCompactionUi';
import {
  getAIPanelDiagnosticHiddenParts,
  getAIPanelProfilerProps,
  isAIPanelDiagnosticPartHidden,
} from './aiPanelDiagnostics';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  /** Active chat session ID — used to filter standalone MCP approval blocks */
  activeSessionId?: string | null;
  activeCompaction?: ActiveCompactionUi | null;
  notes?: VaultNote[];
  hosts?: Host[];
  snippets?: Snippet[];
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSnippet?: (snippetId: string) => void;
  onOpenVaultSection?: (section: VaultArtifactNavSection) => void;
}

interface VaultArtifactNavigationCallbackOptions {
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSnippet?: (snippetId: string) => void;
  onOpenVaultSection?: (section: VaultArtifactNavSection) => void;
}

export function shouldProvideVaultArtifactNavigation({
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSnippet,
  onOpenVaultSection,
}: VaultArtifactNavigationCallbackOptions): boolean {
  return Boolean(onOpenVaultNote || onOpenVaultHost || onOpenVaultSnippet || onOpenVaultSection);
}

const MESSAGE_RENDER_BATCH = 50;
const MESSAGE_RENDER_STEP = 50;

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  isStreaming,
  activeSessionId,
  activeCompaction = null,
  notes = [],
  hosts = [],
  snippets = [],
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSnippet,
  onOpenVaultSection,
}) => {
  // Track pending approvals from the approval gate
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, ApprovalRequest>>(new Map());
  const [resolvedApprovals, setResolvedApprovals] = useState<Map<string, boolean>>(new Map());

  // Subscribe to approval gate events (SDK + MCP tool calls)
  useEffect(() => {
    const handler = (request: ApprovalRequest) => {
      setPendingApprovals(prev => new Map(prev).set(request.toolCallId, request));
    };
    const unsub = onApprovalRequest(handler);
    // Replay any approvals that fired while this component was unmounted
    replayPendingApprovals(handler);
    return unsub;
  }, []);

  // Subscribe to approval cleared/removed events (fired on session stop or timeout)
  useEffect(() => {
    return onApprovalCleared((clearedIds) => {
      setPendingApprovals(prev => {
        const m = new Map(prev);
        for (const id of clearedIds) m.delete(id);
        return m;
      });
    });
  }, []);

  const handleApproveOnce = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, true);
    setPendingApprovals(prev => { const m = new Map(prev); m.delete(toolCallId); return m; });
    setResolvedApprovals(prev => new Map(prev).set(toolCallId, true));
  }, []);

  const handleAlwaysAllow = useCallback((toolCallId: string, request: ApprovalRequest) => {
    const capabilityId = request.capabilityId ?? resolveCapabilityId(request.toolName);
    const persistGrants = buildGrantsFromApproval(capabilityId, request.args, request.chatSessionId);
    resolveApproval(toolCallId, { approved: true, persistGrants });
    setPendingApprovals(prev => { const m = new Map(prev); m.delete(toolCallId); return m; });
    setResolvedApprovals(prev => new Map(prev).set(toolCallId, true));
  }, []);

  const handleReject = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, false);
    setPendingApprovals(prev => { const m = new Map(prev); m.delete(toolCallId); return m; });
    setResolvedApprovals(prev => new Map(prev).set(toolCallId, false));
  }, []);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [dragged, setDragged] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragPos = useRef({ x: 0, y: 0 });
  const dragStart = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const applyTransform = useCallback((z: number, x: number, y: number, animate: boolean) => {
    if (!imgRef.current) return;
    imgRef.current.style.transition = animate ? 'transform 0.25s ease' : 'none';
    imgRef.current.style.transform = `scale(${z / 100}) translate(${x / (z / 100)}px, ${y / (z / 100)}px)`;
  }, []);

  const zoomRef = useRef(100);
  const setZoomAndRef = useCallback((fn: (z: number) => number) => {
    setZoom(z => { const nz = fn(z); zoomRef.current = nz; return nz; });
  }, []);
  const zoomIn = useCallback(() => setZoomAndRef(z => { const nz = Math.min(z + 25, 200); applyTransform(nz, dragPos.current.x, dragPos.current.y, true); return nz; }), [applyTransform, setZoomAndRef]);
  const zoomOut = useCallback(() => setZoomAndRef(z => { const nz = Math.max(z - 25, 25); applyTransform(nz, dragPos.current.x, dragPos.current.y, true); return nz; }), [applyTransform, setZoomAndRef]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    setZoomAndRef(z => {
      const nz = Math.max(25, Math.min(200, z + delta));
      applyTransform(nz, dragPos.current.x, dragPos.current.y, false);
      return nz;
    });
  }, [applyTransform, setZoomAndRef]);
  const openPreview = useCallback((src: string, name: string) => {
    setZoom(100); zoomRef.current = 100;
    setDragged(false);
    dragPos.current = { x: 0, y: 0 };
    setPreview({ src, name });
  }, []);

  const resetPreview = useCallback(() => {
    setZoom(100); zoomRef.current = 100;
    setDragged(false);
    dragPos.current = { x: 0, y: 0 };
    applyTransform(100, 0, 0, true);
  }, [applyTransform]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { startX: e.clientX, startY: e.clientY, origX: dragPos.current.x, origY: dragPos.current.y };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStart.current) return;
    if ((e.buttons & 1) === 0) { dragStart.current = null; return; }
    const x = dragStart.current.origX + (e.clientX - dragStart.current.startX);
    const y = dragStart.current.origY + (e.clientY - dragStart.current.startY);
    dragPos.current = { x, y };
    applyTransform(zoomRef.current, x, y, false);
  }, [applyTransform]);

  const endDrag = useCallback(() => {
    if (dragStart.current && (dragPos.current.x !== 0 || dragPos.current.y !== 0)) {
      setDragged(true);
    }
    dragStart.current = null;
  }, []);
  const { t } = useI18n();
  const hiddenParts = getAIPanelDiagnosticHiddenParts();
  const hideAttachments = isAIPanelDiagnosticPartHidden('attachments', hiddenParts);
  const hideMarkdown = isAIPanelDiagnosticPartHidden('markdown', hiddenParts);
  const hideToolCalls = isAIPanelDiagnosticPartHidden('toolcalls', hiddenParts);
  const [renderedTailCount, setRenderedTailCount] = useState(MESSAGE_RENDER_BATCH);

  useEffect(() => {
    setRenderedTailCount(MESSAGE_RENDER_BATCH);
  }, [activeSessionId]);

  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role !== 'system'),
    [messages],
  );

  const hiddenMessageCount = Math.max(0, visibleMessages.length - renderedTailCount);
  const displayedMessages = hiddenMessageCount > 0
    ? visibleMessages.slice(-renderedTailCount)
    : visibleMessages;

  const resolvedToolCallIds = new Set(
    displayedMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.toolResults?.map((tr) => tr.toolCallId) ?? []),
  );

  // Build maps from toolCallId → toolName / toolArgs for display
  const toolCallNames = new Map<string, string>();
  const toolCallArgs = new Map<string, Record<string, unknown>>();
  for (const m of displayedMessages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolCallNames.set(tc.id, tc.name);
        if (tc.arguments) toolCallArgs.set(tc.id, tc.arguments);
      }
    }
  }

  if (visibleMessages.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-[13px] text-muted-foreground/40 text-center">
          {t('ai.chat.emptyHint')}
        </p>
      </div>
    );
  }

  const lastAssistantMessage = displayedMessages.findLast(m => m.role === 'assistant');
  const showCompactionStatus = Boolean(
    activeCompaction
    && activeSessionId
    && activeCompaction.sessionId === activeSessionId,
  );

  const conversation = (
    <>
    <Conversation className="flex-1">
      <ConversationContent className="gap-1.5 px-4 py-2">
        {hiddenMessageCount > 0 && (
          <button
            type="button"
            onClick={() => setRenderedTailCount((count) => count + MESSAGE_RENDER_STEP)}
            className="w-full py-2 text-center text-[12px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
          >
            {t('ai.chat.loadEarlierMessages').replace('{n}', String(hiddenMessageCount))}
          </button>
        )}
        {displayedMessages.map((message, idx) => {
          if (message.role === 'tool') {
            // Group consecutive tool messages into a collapsible section
            // Skip if this is NOT the first in a consecutive run
            const prevIsTool = idx > 0 && displayedMessages[idx - 1].role === "tool";
            if (prevIsTool || hideToolCalls) return null;

            // Collect this run of consecutive tool messages
            let end = idx + 1;
            while (end < displayedMessages.length && displayedMessages[end].role === "tool") end++;
            const group = displayedMessages.slice(idx, end);
            const toolResults = group.flatMap((toolMsg) =>
              (toolMsg.toolResults ?? []).map((tr) => {
                const args = toolCallArgs.get(tr.toolCallId);
                const resultToolName = typeof tr.toolName === 'string' ? tr.toolName : undefined;
                const pairedToolName = toolCallNames.get(tr.toolCallId);
                const artifactToolName =
                  inferArtifactToolNameFromCliArgs(args)
                  ?? normalizeArtifactToolName(resultToolName)
                  ?? normalizeArtifactToolName(pairedToolName);
                return {
                  toolCallId: tr.toolCallId,
                  name: pairedToolName || resultToolName || tr.toolCallId,
                  artifactToolName,
                  args,
                  content: tr.content,
                  isError: tr.isError,
                };
              }),
            );
            const groupTotal = toolResults.length;

            // Expanded while the agent is still working (no assistant response follows)
            const hasAssistantAfter = end < displayedMessages.length
              && displayedMessages[end].role === "assistant";

            const renderToolResultItem = (item: typeof toolResults[number]) => {
              const artifactToolName = item.artifactToolName ?? item.name;
              const terminalArtifact = parseTerminalToolArtifact(artifactToolName, item.content);
              if (terminalArtifact) {
                return (
                  <TerminalArtifactToolResult
                    key={item.toolCallId}
                    artifact={terminalArtifact}
                    toolName={artifactToolName}
                    args={item.args}
                    result={item.content}
                    isError={item.isError}
                  />
                );
              }
              const artifact = parseVaultToolArtifact(artifactToolName, item.content);
              if (artifact) {
                return (
                  <VaultArtifactToolResult
                    key={item.toolCallId}
                    artifact={artifact}
                    toolName={artifactToolName}
                    args={item.args}
                    result={item.content}
                    isError={item.isError}
                  />
                );
              }
              return (
                <React.Profiler key={item.toolCallId} {...getAIPanelProfilerProps("AIChatPanel.ToolCall.Result")}>
                  <div>
                    <ToolCall
                      name={item.name}
                      args={item.args}
                      result={item.content}
                      isError={item.isError}
                    />
                  </div>
                </React.Profiler>
              );
            };

            if (groupTotal === 1) {
              return (
                <div key={`tool-group-${message.id}`} className="py-0.5">
                  {renderToolResultItem(toolResults[0])}
                </div>
              );
            }

            return (
              <ToolCallGroup
                key={`tool-group-${message.id}`}
                count={groupTotal}
                defaultExpanded={!hasAssistantAfter}
              >
                {toolResults.map(renderToolResultItem)}
              </ToolCallGroup>
            );
          }

          const isUser = message.role === 'user';
          const isLastAssistant = message === lastAssistantMessage;
          const isThisStreaming = isStreaming && isLastAssistant;

          return (
            <Message key={message.id} from={message.role}>
              <MessageContent from={message.role}>
                {/* Thinking block */}
                {!isUser && message.thinking && (
                  <ThinkingBlock
                    content={message.thinking}
                    isStreaming={!!isThisStreaming && !message.content}
                    durationMs={message.thinkingDurationMs}
                  />
                )}

                {/* User attachments (images, files) — fallback to legacy `images` field */}
                {isUser && !hideAttachments && (message.attachments ?? message.images)?.length && (
                  <div className="flex gap-1.5 flex-wrap mb-1">
                    {(message.attachments ?? message.images)!.map((att, i) => (
                      att.terminalSelection ? (
                        <div
                          key={att.filename ? `${att.filename}-${i}` : `att-${message.id}-${i}`}
                          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md bg-muted/20 border border-border/20 text-[11px] text-foreground/70"
                        >
                          <SquareTerminal size={12} className="text-muted-foreground/60 shrink-0" />
                          <span className="truncate max-w-[150px]">{att.filename || 'terminal selection'}</span>
                        </div>
                      ) : att.mediaType.startsWith('image/') ? (
                        <img
                          key={att.filename ? `${att.filename}-${i}` : `att-${message.id}-${i}`}
                          src={`data:${att.mediaType};base64,${att.base64Data}`}
                          alt={att.filename || 'image'}
                          className="max-h-[120px] max-w-[200px] rounded-md object-contain border border-border/20 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => openPreview(`data:${att.mediaType};base64,${att.base64Data}`, att.filename || 'image')}
                        />
                      ) : (
                        <div
                          key={att.filename ? `${att.filename}-${i}` : `att-${message.id}-${i}`}
                          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md bg-muted/20 border border-border/20 text-[11px] text-foreground/70"
                        >
                          <FileText size={12} className="text-muted-foreground/60 shrink-0" />
                          <span className="truncate max-w-[120px]">{att.filename || 'file'}</span>
                        </div>
                      )
                    ))}
                  </div>
                )}

                {message.content && (
                  isUser
                    ? <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]">{message.content}</div>
                    : hideMarkdown
                      ? <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]">{message.content}</div>
                      : (
                          <React.Profiler {...getAIPanelProfilerProps('AIChatPanel.Markdown')}>
                            <MessageResponse isAnimating={isThisStreaming}>
                              {message.content}
                            </MessageResponse>
                          </React.Profiler>
                        )
                )}

                {/* Pending tool calls from the *last* assistant message are rendered
                    after all tool-result messages (see below) for chronological order.
                    Unresolved tool calls from earlier or cancelled messages are shown
                    inline — as interrupted, or with approval controls if still pending. */}
{(() => {
                  if (hideToolCalls) return null;
                  if (message === lastAssistantMessage && message.executionStatus !== "cancelled") return null;
                  const unresolvedTcs = message.toolCalls?.filter((tc) => !resolvedToolCallIds.has(tc.id)) ?? [];
                  if (unresolvedTcs.length === 0) return null;
                  return (
                    <ToolCallGroup count={unresolvedTcs.length} defaultExpanded={false}>
                      {unresolvedTcs.map((tc) => {
                        const isPending = pendingApprovals.has(tc.id);
                        const resolved = resolvedApprovals.get(tc.id);
                        const approvalStatus = isPending
                          ? "pending" as const
                          : resolved === true
                            ? "approved" as const
                            : resolved === false
                              ? "denied" as const
                              : undefined;
                        return (
                          <div key={tc.id} className="px-2 py-1.5">
                            <ToolCall
                              name={tc.name}
                              args={tc.arguments}
                              isInterrupted={!isPending}
                              approvalStatus={approvalStatus}
                              onApproveOnce={() => handleApproveOnce(tc.id)}
                              onAlwaysAllow={() => handleAlwaysAllow(tc.id, pendingApprovals.get(tc.id) ?? {
                                toolCallId: tc.id,
                                toolName: tc.name,
                                args: tc.arguments ?? {},
                                chatSessionId: activeSessionId ?? undefined,
                              })}
                              onReject={() => handleReject(tc.id)}
                            />
                          </div>
                        );
                      })}
                    </ToolCallGroup>
                  );
                })()}

                {/* Status text with shimmer */}
                {message.statusText && (
                  <div className="py-1">
                    <span className="thinking-shimmer text-xs">
                      {resolveCompactionStatusText(message.statusText, t)}
                    </span>
                  </div>
                )}

                {/* Error info */}
                {message.errorInfo && (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-sm">
                    <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-destructive font-medium whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                        {message.errorInfo.message}
                      </p>
                      {message.errorInfo.retryable && (
                        <p className="text-muted-foreground text-xs mt-1">{t('ai.chat.retryHint')}</p>
                      )}
                    </div>
                  </div>
                )}
              </MessageContent>
            </Message>
          );
        })}

        {/* Pending tool calls from the last assistant message — rendered here
            (after all tool-result messages) so they appear at the bottom. */}
{(() => {
          if (hideToolCalls) return null;
          const pendingTcs = lastAssistantMessage?.toolCalls?.filter((tc) =>
            !resolvedToolCallIds.has(tc.id) && lastAssistantMessage.executionStatus !== "cancelled",
          ) ?? [];
          if (pendingTcs.length === 0) return null;
          const isActive = lastAssistantMessage.executionStatus !== "error";
          const isToolRunning = !!(isStreaming && lastAssistantMessage.executionStatus === "running");
          return (
            <ToolCallGroup count={pendingTcs.length} defaultExpanded={isActive}>
              {pendingTcs.map((tc) => {
                const isPending = pendingApprovals.has(tc.id);
                const resolved = resolvedApprovals.get(tc.id);
                const approvalStatus = isPending
                  ? "pending" as const
                  : resolved === true
                    ? "approved" as const
                    : resolved === false
                      ? "denied" as const
                      : undefined;
                return (
                  <div key={tc.id} className="px-2 py-1.5">
                    <ToolCall
                      name={tc.name}
                      args={tc.arguments}
                      isLoading={isToolRunning && !isPending}
                      approvalStatus={approvalStatus}
                      onApproveOnce={() => handleApproveOnce(tc.id)}
                      onAlwaysAllow={() => handleAlwaysAllow(tc.id, pendingApprovals.get(tc.id) ?? {
                        toolCallId: tc.id,
                        toolName: tc.name,
                        args: tc.arguments ?? {},
                        chatSessionId: activeSessionId ?? undefined,
                      })}
                      onReject={() => handleReject(tc.id)}
                    />
                  </div>
                );
              })}
            </ToolCallGroup>
          );
        })()}

        {/* Standalone MCP/SDK approval requests (not tied to SDK tool calls) */}
        {!hideToolCalls && Array.from(pendingApprovals.entries())
          .filter(([id, req]) => id.startsWith('mcp_approval_') && (!activeSessionId || req.chatSessionId === activeSessionId))
          .map(([id, req]) => {
            return (
              <React.Profiler key={id} {...getAIPanelProfilerProps('AIChatPanel.ToolCall.Approval')}>
                <div>
                  <ToolCall
                    name={req.toolName}
                    args={req.args}
                    isLoading={false}
                    isInterrupted={false}
                    approvalStatus={'pending'}
                    onApproveOnce={() => handleApproveOnce(id)}
                    onAlwaysAllow={() => handleAlwaysAllow(id, req)}
                    onReject={() => handleReject(id)}
                  />
                </div>
              </React.Profiler>
            );
          })}
        {/* Transient compaction status — inline, no banner */}
        {showCompactionStatus && activeCompaction && (
          <div className="py-1">
            <span className="thinking-shimmer text-xs text-muted-foreground">
              {compactionStatusText(activeCompaction.trigger, t)}
            </span>
          </div>
        )}

        {/* Streaming indicator — only when no content and no thinking yet */}
        {isStreaming && !lastAssistantMessage?.content && !lastAssistantMessage?.thinking && (
          <div className="flex items-center gap-1 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>

    {/* Image preview lightbox */}
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
      <DialogContent
        hideCloseButton
        className="max-w-[min(90vw,800px)] max-h-[min(90vh,700px)] min-w-[280px] min-h-[200px] w-fit p-0 gap-0 focus:outline-none shadow-2xl"
      >
        {/* Title bar: filename | zoom controls | close — all in one flex row */}
        <div className="flex items-center h-10 px-3 border-b border-border/40 gap-2 shrink-0">
          <DialogTitle className="text-sm font-medium truncate flex-1">{preview?.name}</DialogTitle>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={resetPreview}
              disabled={zoom === 100 && !dragged}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
              aria-label={t('common.reset')}
            >
              <RotateCcw size={14} />
            </button>
            <div className="w-px h-3.5 bg-border/40 mx-0.5" />
            <button
              onClick={zoomOut}
              disabled={zoom <= 25}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
              aria-label={t('common.zoomOut')}
            >
              <ZoomOut size={14} />
            </button>
            <span className="text-xs text-muted-foreground tabular-nums w-9 text-center select-none">{zoom}%</span>
            <button
              onClick={zoomIn}
              disabled={zoom >= 200}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
              aria-label={t('common.zoomIn')}
            >
              <ZoomIn size={14} />
            </button>
          </div>
          <button
            onClick={() => setPreview(null)}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground shrink-0"
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>
        {/* Image area with drag support */}
        {preview && (
          <div
            className="overflow-hidden flex items-center justify-center"
            style={{
              height: 'calc(min(90vh, 700px) - 40px)',
              cursor: 'grab',
              // Clamp aspect ratio: if image is extremely tall/wide, the container
              // constrains it; object-contain handles the rest.
              aspectRatio: 'auto',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={onWheel}
            onLostPointerCapture={endDrag}
          >
            <img
              ref={imgRef}
              src={preview.src}
              alt={preview.name}
              draggable={false}
              className="select-none max-w-full max-h-full object-contain"
              style={{ transition: 'transform 0.25s ease' }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );

  if (shouldProvideVaultArtifactNavigation({
    onOpenVaultNote,
    onOpenVaultHost,
    onOpenVaultSnippet,
    onOpenVaultSection,
  })) {
    return (
      <VaultArtifactNavigationProvider
        notes={notes}
        hosts={hosts}
        snippets={snippets}
        onOpenVaultNote={onOpenVaultNote}
        onOpenVaultHost={onOpenVaultHost}
        onOpenVaultSnippet={onOpenVaultSnippet}
        onOpenVaultSection={onOpenVaultSection}
      >
        {conversation}
      </VaultArtifactNavigationProvider>
    );
  }

  return conversation;
};

function areMessagesEqual(prev: ChatMessageListProps, next: ChatMessageListProps): boolean {
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.activeSessionId !== next.activeSessionId) return false;
  if (prev.notes !== next.notes) return false;
  if (prev.hosts !== next.hosts) return false;
  if (prev.snippets !== next.snippets) return false;
  if (prev.onOpenVaultNote !== next.onOpenVaultNote) return false;
  if (prev.onOpenVaultHost !== next.onOpenVaultHost) return false;
  if (prev.onOpenVaultSnippet !== next.onOpenVaultSnippet) return false;
  if (prev.onOpenVaultSection !== next.onOpenVaultSection) return false;
  if (prev.messages.length !== next.messages.length) return false;
  if (prev.messages === next.messages) return true;

  // Shallow-compare each message by reference
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) {
      // For the last message during streaming, compare by content to avoid
      // re-renders when only the array reference changed but content is the same
      const p = prev.messages[i];
      const n = next.messages[i];
      if (
        p.id !== n.id ||
        p.content !== n.content ||
        p.thinking !== n.thinking ||
        p.role !== n.role ||
        p.statusText !== n.statusText ||
        p.executionStatus !== n.executionStatus ||
        p.errorInfo !== n.errorInfo ||
        p.toolCalls !== n.toolCalls ||
        p.toolResults !== n.toolResults
      ) {
        return false;
      }
    }
  }

  return true;
}

export default React.memo(ChatMessageList, areMessagesEqual);
