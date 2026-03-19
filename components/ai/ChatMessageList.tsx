/**
 * ChatMessageList - Renders the list of chat messages
 *
 * Claude-Code-style: user messages in bordered bubbles (right-aligned),
 * assistant responses as plain text (left-aligned, no border/bg).
 * No avatars. Thinking blocks are collapsible.
 */

import { AlertCircle, FileText, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
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
import { InlineApprovalCard } from './InlineApprovalCard';
import ThinkingBlock from './ThinkingBlock';

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  onApprove?: (messageId: string) => void;
  onReject?: (messageId: string) => void;
}

const ChatMessageList: React.FC<ChatMessageListProps> = ({ messages, isStreaming, onApprove, onReject }) => {
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const zoomIn = useCallback(() => setZoom(z => Math.min(z + 25, 200)), []);
  const zoomOut = useCallback(() => setZoom(z => Math.max(z - 25, 25)), []);
  const openPreview = useCallback((src: string, name: string) => {
    setZoom(100);
    setDrag({ x: 0, y: 0 });
    setPreview({ src, name });
  }, []);

  const resetPreview = useCallback(() => { setZoom(100); setDrag({ x: 0, y: 0 }); }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: drag.x, origY: drag.y };
  }, [drag]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setDrag({
      x: dragRef.current.origX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.origY + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);
  const { t } = useI18n();
  const visibleMessages = messages.filter(m => m.role !== 'system');
  const resolvedToolCallIds = new Set(
    visibleMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.toolResults?.map((tr) => tr.toolCallId) ?? []),
  );

  // Build a map from toolCallId → toolName for display
  const toolCallNames = new Map<string, string>();
  for (const m of visibleMessages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolCallNames.set(tc.id, tc.name);
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

  const lastAssistantMessage = visibleMessages.findLast(m => m.role === 'assistant');

  return (
    <>
    <Conversation className="flex-1">
      <ConversationContent className="gap-1.5 px-4 py-2">
        {visibleMessages.map((message) => {
          if (message.role === 'tool') {
            return (
              <React.Fragment key={message.id}>
                {message.toolResults?.map((tr) => (
                  <ToolCall
                    key={tr.toolCallId}
                    name={toolCallNames.get(tr.toolCallId) || tr.toolCallId}
                    result={tr.content}
                    isError={tr.isError}
                  />
                ))}
              </React.Fragment>
            );
          }

          const isUser = message.role === 'user';
          const isLastAssistant = message === lastAssistantMessage;
          const isThisStreaming = isStreaming && isLastAssistant;

          return (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {/* Thinking block */}
                {!isUser && message.thinking && (
                  <ThinkingBlock
                    content={message.thinking}
                    isStreaming={!!isThisStreaming && !message.content}
                    durationMs={message.thinkingDurationMs}
                  />
                )}

                {/* User attachments (images, files) — fallback to legacy `images` field */}
                {isUser && (message.attachments ?? message.images)?.length && (
                  <div className="flex gap-1.5 flex-wrap mb-1">
                    {(message.attachments ?? message.images)!.map((att, i) => (
                      att.mediaType.startsWith('image/') ? (
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
                    ? <div className="whitespace-pre-wrap break-words text-[13px]">{message.content}</div>
                    : <MessageResponse isAnimating={isThisStreaming}>
                        {message.content}
                      </MessageResponse>
                )}

                {/* Tool calls */}
                {message.toolCalls?.map((tc) => (
                  <ToolCall
                    key={tc.id}
                    name={tc.name}
                    args={tc.arguments}
                    isLoading={isThisStreaming && message.executionStatus === 'running'}
                    isInterrupted={message.executionStatus === 'cancelled' && !resolvedToolCallIds.has(tc.id)}
                  />
                ))}

                {/* Inline approval card */}
                {message.pendingApproval && (
                  <InlineApprovalCard
                    toolName={message.pendingApproval.toolName}
                    toolArgs={message.pendingApproval.toolArgs}
                    status={message.pendingApproval.status}
                    onApprove={() => onApprove?.(message.id)}
                    onReject={() => onReject?.(message.id)}
                  />
                )}

                {/* Status text with shimmer */}
                {message.statusText && (
                  <div className="py-1">
                    <span className="thinking-shimmer text-xs">{message.statusText}</span>
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
        className="max-w-[min(90vw,800px)] max-h-[min(90vh,700px)] min-w-[280px] min-h-[200px] w-fit p-0 gap-0 focus:outline-none"
        overlayClassName="bg-black/50 backdrop-blur-sm"
      >
        {/* Title bar: filename | zoom controls | close — all in one flex row */}
        <div className="flex items-center h-10 px-3 border-b border-border/40 gap-2 shrink-0">
          <DialogTitle className="text-sm font-medium truncate flex-1">{preview?.name}</DialogTitle>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={resetPreview}
              disabled={zoom === 100 && drag.x === 0 && drag.y === 0}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
              title="Reset"
            >
              <RotateCcw size={14} />
            </button>
            <div className="w-px h-3.5 bg-border/40 mx-0.5" />
            <button
              onClick={zoomOut}
              disabled={zoom <= 25}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
            >
              <ZoomOut size={14} />
            </button>
            <span className="text-xs text-muted-foreground tabular-nums w-9 text-center select-none">{zoom}%</span>
            <button
              onClick={zoomIn}
              disabled={zoom >= 200}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors text-muted-foreground"
            >
              <ZoomIn size={14} />
            </button>
          </div>
          <button
            onClick={() => setPreview(null)}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground shrink-0"
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
            onPointerUp={onPointerUp}
          >
            <img
              src={preview.src}
              alt={preview.name}
              draggable={false}
              className="select-none max-w-full max-h-full object-contain"
              style={{
                transform: `scale(${zoom / 100}) translate(${drag.x / (zoom / 100)}px, ${drag.y / (zoom / 100)}px)`,
                transition: dragRef.current ? 'none' : 'transform 0.25s ease',
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
};

function areMessagesEqual(prev: ChatMessageListProps, next: ChatMessageListProps): boolean {
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.onApprove !== next.onApprove) return false;
  if (prev.onReject !== next.onReject) return false;
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
        p.pendingApproval !== n.pendingApproval ||
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
