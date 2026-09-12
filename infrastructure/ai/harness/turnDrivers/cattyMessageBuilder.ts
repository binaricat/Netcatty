import type { ModelMessage } from 'ai';
import type {
  AISessionContextCompaction,
  ChatMessage,
  ChatMessageAttachment,
  ToolResult,
} from '../../types';
import { buildTerminalWriteFingerprint } from '../toolResultDedup';
import {
  buildHistoricalToolReplayMaps,
  buildHistoricalToolResultReplayText,
  buildHistoricalUserReplayContent,
} from '../../../../components/ai/cattyHistoryReplay';
import {
  buildPromptWithTerminalSelectionAttachments,
  isInlineTextAttachment,
} from '../../../../application/state/terminalSelectionAttachment';
import {
  getOpenAIChatAssistantFieldsForHistoryMessage,
  isProviderContinuationForSource,
  type OpenAIChatAssistantFields,
  type ProviderContinuation,
  type ProviderContinuationReasoningPart,
} from '../../providerContinuation';
import {
  toAssistantModelContent,
  type AssistantContentPart,
  type CattyProviderContinuationContext,
} from '../../aiChatStreamingSupport';
import { redactSecretsInValueForModel } from '../modelSecretRedaction';
import { fitLargeUserInputForModel } from '../largeUserInput';
import type { ToolOutputStore } from '../toolOutputStore';

const OPENAI_CHAT_ASSISTANT_FIELDS = Symbol('netcatty.openAIChatAssistantFields');

type ModelMessageWithOpenAIChatFields = ModelMessage & {
  [OPENAI_CHAT_ASSISTANT_FIELDS]?: OpenAIChatAssistantFields;
};

function rememberOpenAIChatAssistantFields(
  message: ModelMessage,
  fields: OpenAIChatAssistantFields | undefined,
  fieldsByMessage: Map<ModelMessage, OpenAIChatAssistantFields | undefined>,
): void {
  fieldsByMessage.set(message, fields);
  (message as ModelMessageWithOpenAIChatFields)[OPENAI_CHAT_ASSISTANT_FIELDS] = fields;
}

function getRememberedOpenAIChatAssistantFields(
  message: ModelMessage,
  fieldsByMessage: Map<ModelMessage, OpenAIChatAssistantFields | undefined>,
): OpenAIChatAssistantFields | undefined {
  if (fieldsByMessage.has(message)) return fieldsByMessage.get(message);
  return (message as ModelMessageWithOpenAIChatFields)[OPENAI_CHAT_ASSISTANT_FIELDS];
}

function modelMessageHasToolCall(message: ModelMessage): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call');
}

/**
 * Legacy Responses histories — recorded before `reasoning-end` capture — store
 * reasoning parts that carry only the server-side `rs_…` item id and no
 * `reasoningEncryptedContent`. Replaying them against a stateless
 * (`store: false`) Responses turn makes the SDK emit a `reasoning` item
 * referencing an id that was never persisted, which the API rejects
 * ("Item with id 'rs_…' not found"), leaving the conversation unable to
 * continue. Dropping just the reasoning part is not enough: OpenAI Responses
 * stateless tool loops require the reasoning item to accompany its
 * function-call output, so replaying the paired `fc_…` call/result without it
 * is also rejected. Discard the entire incompatible call/result exchange
 * before replay (the assistant's plain text is still replayed); tool results
 * that reference the discarded call ids are skipped as well. Reasoning parts
 * with real ciphertext (or no OpenAI item id at all) are kept untouched.
 */
function getReasoningOpenAIItemId(
  part: ProviderContinuationReasoningPart,
): string | undefined {
  const openaiOptions = part.providerOptions?.openai as
    | { itemId?: unknown }
    | undefined;
  const itemId = openaiOptions?.itemId;
  return typeof itemId === 'string' && itemId ? itemId : undefined;
}

function partHasReasoningEncryptedContent(
  part: ProviderContinuationReasoningPart,
): boolean {
  const openaiOptions = part.providerOptions?.openai as
    | { reasoningEncryptedContent?: unknown }
    | undefined;
  return typeof openaiOptions?.reasoningEncryptedContent === 'string'
    && openaiOptions.reasoningEncryptedContent.length > 0;
}

function hasOpenAIResponsesReasoningMetadata(
  parts: readonly ProviderContinuationReasoningPart[],
): boolean {
  return parts.some(part => (
    getReasoningOpenAIItemId(part) !== undefined
    || partHasReasoningEncryptedContent(part)
  ));
}

/**
 * A single Responses reasoning item is streamed as several fragments
 * (`reasoning-start`/`reasoning-delta`/`reasoning-end`): the initial fragment
 * carries only the item id (with `reasoningEncryptedContent: null`), deltas
 * omit the key, and the ciphertext arrives on the final fragment. The merge
 * therefore keeps an ID-only fragment next to the encrypted one for the *same*
 * item, so replayability must be decided per item id: an item is unreplayable
 * statelessly only when *no* fragment for that id carries ciphertext (the
 * legacy case where only the id was recorded). Fragments without an OpenAI
 * item id are always replayable.
 */
function hasUnreplayableReasoningItems(
  parts: readonly ProviderContinuationReasoningPart[],
): boolean {
  const itemIds = new Set<string>();
  const itemIdsWithCiphertext = new Set<string>();
  let hasCiphertextWithoutItemId = false;
  for (const part of parts) {
    const itemId = getReasoningOpenAIItemId(part);
    if (!itemId) {
      if (partHasReasoningEncryptedContent(part)) {
        hasCiphertextWithoutItemId = true;
      }
      continue;
    }
    itemIds.add(itemId);
    if (partHasReasoningEncryptedContent(part)) {
      itemIdsWithCiphertext.add(itemId);
    }
  }
  for (const itemId of itemIds) {
    if (!itemIdsWithCiphertext.has(itemId)) return true;
  }
  // The Responses converter also skips reasoning that has neither an item id
  // nor encrypted content. If that is the only reasoning attached to a tool
  // exchange, replaying the call/result without it is unsafe. Plain delta
  // fragments are still accepted when another fragment supplies the item's
  // ciphertext.
  return parts.length > 0 && itemIds.size === 0 && !hasCiphertextWithoutItemId;
}

/**
 * Replayability is decided per reasoning item id (see
 * {@link hasUnreplayableReasoningItems}): when any fragment of an item carries
 * ciphertext, every fragment of that item is replayable. Filtering fragments
 * independently would drop the earlier text fragments of a multi-fragment
 * item whose ciphertext arrives only on the final fragment, truncating the
 * reasoning item sent on later turns.
 */
function collectReplayableReasoningParts(
  continuation: ProviderContinuation | undefined,
): ProviderContinuationReasoningPart[] {
  const parts = continuation?.reasoningParts ?? [];
  const itemIdsWithCiphertext = new Set<string>();
  for (const part of parts) {
    const itemId = getReasoningOpenAIItemId(part);
    if (itemId && partHasReasoningEncryptedContent(part)) {
      itemIdsWithCiphertext.add(itemId);
    }
  }
  return parts.filter((part) => {
    const itemId = getReasoningOpenAIItemId(part);
    if (!itemId) return true;
    if (!itemIdsWithCiphertext.has(itemId)) return false;
    // The empty ID-only start fragment of a replayable item is redundant: the
    // encrypted fragment for the same item already identifies it, and
    // replaying both would duplicate the item id.
    return part.text.length > 0 || partHasReasoningEncryptedContent(part);
  });
}

export function collectOpenAIChatAssistantFieldsForMessages(
  messages: ModelMessage[],
  fieldsByMessage: Map<ModelMessage, OpenAIChatAssistantFields | undefined>,
): Array<OpenAIChatAssistantFields | undefined> {
  const fields: Array<OpenAIChatAssistantFields | undefined> = [];
  let previousMessageWasTool = false;
  for (const message of messages) {
    const needsContinuationFields = message.role === 'assistant'
      && (modelMessageHasToolCall(message) || previousMessageWasTool);
    if (needsContinuationFields) {
      fields.push(getRememberedOpenAIChatAssistantFields(message, fieldsByMessage));
    }
    previousMessageWasTool = message.role === 'tool';
  }
  return fields;
}

export interface BuildCattySdkMessagesInput {
  allMessages: ChatMessage[];
  contextCompaction?: AISessionContextCompaction;
  includeCurrentUserMessage: boolean;
  trimmed: string;
  attachments?: ChatMessageAttachment[];
  continuationContext: CattyProviderContinuationContext;
  preserveTerminalToolResults?: ReadonlySet<ToolResult>;
  chatSessionId: string;
  toolOutputStore: ToolOutputStore;
  fieldsByMessage: Map<ModelMessage, OpenAIChatAssistantFields | undefined>;
}

export function buildCattySdkMessages(input: BuildCattySdkMessagesInput): ModelMessage[] {
  const {
    allMessages,
    contextCompaction,
    includeCurrentUserMessage,
    trimmed,
    attachments,
    continuationContext,
    preserveTerminalToolResults = new Set<ToolResult>(),
    chatSessionId,
    toolOutputStore,
    fieldsByMessage,
  } = input;

  const { resolvedToolCallsByAssistant, toolCallByToolResult } = buildHistoricalToolReplayMaps(allMessages);
  const nextFieldsByMessage = new Map<ModelMessage, OpenAIChatAssistantFields | undefined>();
  const sdkMessages: ModelMessage[] = [];
  // Call ids whose exchange was discarded because the paired reasoning item is
  // not replayable statelessly; their tool results must not be replayed either.
  const discardedToolCallIds = new Set<string>();
  let previousHistoryMessageWasToolResult = false;

  const compactedMessageCount = Math.min(
    allMessages.length,
    Math.max(0, contextCompaction?.compactedMessageCount ?? 0),
  );
  // The boundary can become zero when storage trims messages that were all
  // covered by the durable summary. Keep injecting that summary even though
  // no remaining persisted message needs to be skipped.
  if (contextCompaction?.summary) {
    sdkMessages.push({
      role: 'user',
      content: `[Previous conversation summary]\n\n${contextCompaction.summary}\n\n[Continue with the recent messages below.]`,
    });
    sdkMessages.push({
      role: 'assistant',
      content: 'I understand the previous conversation summary and will continue from the recent messages.',
    });
  }

  for (const m of allMessages.slice(compactedMessageCount)) {
    const currentMessageFollowsToolResult = previousHistoryMessageWasToolResult;
    if (m.role === 'user') {
      const messageAttachments = m.attachments ?? m.images;
      const boundedContent = fitLargeUserInputForModel(m.content, chatSessionId, toolOutputStore);
      sdkMessages.push({
        role: 'user',
        content: buildHistoricalUserReplayContent(boundedContent, messageAttachments ?? []),
      });
    } else if (m.role === 'assistant') {
      const activeContinuation = isProviderContinuationForSource(
        m.providerContinuation,
        continuationContext.source,
      )
        ? m.providerContinuation
        : undefined;
      const hasStoredOpenAIChatAssistantFields = Object.keys(
        m.providerContinuation?.openAIChatAssistantFields ?? {},
      ).length > 0;
      // Provider/model identity alone cannot distinguish a Chat history from
      // a Responses history when the user changes only the API format. Chat
      // continuation fields are explicit evidence that its provider-specific
      // reasoning must not be replayed as a Responses reasoning item.
      const replayContinuation = continuationContext.usesOpenAIResponses
        && hasStoredOpenAIChatAssistantFields
        ? undefined
        : activeContinuation;
      const openAIChatAssistantFields = continuationContext.usesOpenAIResponses
        ? undefined
        : getOpenAIChatAssistantFieldsForHistoryMessage(
          m,
          continuationContext.source,
        );
      if (m.toolCalls?.length) {
        const resolvedToolCalls = resolvedToolCallsByAssistant.get(m);
        const resolvedCalls = resolvedToolCalls
          ? m.toolCalls.filter(tc => resolvedToolCalls.has(tc))
          : [];
        // An unreplayable (id-only, never encrypted) reasoning item poisons
        // the whole Responses tool exchange: without it the paired
        // function-call output is rejected, so discard the calls instead of
        // replaying them orphaned. The same applies when a model switch makes
        // reasoning metadata belong to a different source: it cannot be sent
        // to the active Responses model, so its tool exchange must not be sent
        // without it. Freshly streamed items whose ciphertext arrived on a
        // later fragment stay replayable.
        const storedReasoningParts = m.providerContinuation?.reasoningParts ?? [];
        const storedSource = m.providerContinuation?.source;
        const sameProviderConfig = storedSource?.providerConfigId
          === continuationContext.source.providerConfigId
          && storedSource?.providerType === continuationContext.source.providerType;
        const hasSourceMismatchedReasoning = !replayContinuation
          && (
            hasOpenAIResponsesReasoningMetadata(storedReasoningParts)
            // A model change within the same Responses configuration is also
            // enough evidence that metadata-free reasoning came from this
            // wire format. Cross-provider Anthropic/Google reasoning remains
            // a generic, replayable call/result exchange. OpenAI Chat history
            // is also generic when its captured assistant fields identify the
            // original wire format.
            || (
              sameProviderConfig
              && storedReasoningParts.length > 0
              && !hasStoredOpenAIChatAssistantFields
            )
          );
        const hasUnreplayableReasoning = resolvedCalls.length > 0
          && continuationContext.usesOpenAIResponses
          && (
            hasSourceMismatchedReasoning
            || hasUnreplayableReasoningItems(replayContinuation?.reasoningParts ?? [])
          );
        if (hasUnreplayableReasoning) {
          for (const tc of resolvedCalls) discardedToolCallIds.add(tc.id);
        }
        const replayedCalls = hasUnreplayableReasoning ? [] : resolvedCalls;
        const contentParts: AssistantContentPart[] = [];
        if (replayedCalls.length > 0) {
          for (const part of collectReplayableReasoningParts(replayContinuation)) {
            if (!part.text && !part.providerOptions) continue;
            contentParts.push({
              type: 'reasoning' as const,
              text: part.text,
              ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
            });
          }
        }
        if (m.content) {
          contentParts.push({
            type: 'text' as const,
            text: m.content,
            ...(replayContinuation?.textProviderOptions ? { providerOptions: replayContinuation.textProviderOptions } : {}),
          });
        }
        for (const tc of replayedCalls) {
          const providerOptions = replayContinuation?.toolCallProviderOptionsById?.[tc.id];
          contentParts.push({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: redactSecretsInValueForModel(tc.arguments ?? {}),
            ...(providerOptions ? { providerOptions } : {}),
          });
        }
        if (contentParts.length > 0) {
          const message: ModelMessage = { role: 'assistant', content: toAssistantModelContent(contentParts) };
          sdkMessages.push(message);
          if (replayedCalls.length > 0) {
            rememberOpenAIChatAssistantFields(message, openAIChatAssistantFields, nextFieldsByMessage);
          }
        }
      } else if (m.content) {
        const contentParts: AssistantContentPart[] = [];
        for (const part of collectReplayableReasoningParts(replayContinuation)) {
          if (!part.text && !part.providerOptions) continue;
          contentParts.push({
            type: 'reasoning' as const,
            text: part.text,
            ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
          });
        }
        contentParts.push({
          type: 'text' as const,
          text: m.content,
          ...(replayContinuation?.textProviderOptions ? { providerOptions: replayContinuation.textProviderOptions } : {}),
        });
        const message: ModelMessage = {
          role: 'assistant',
          content: toAssistantModelContent(contentParts),
        };
        sdkMessages.push(message);
        if (currentMessageFollowsToolResult) {
          rememberOpenAIChatAssistantFields(message, openAIChatAssistantFields, nextFieldsByMessage);
        }
      }
    } else if (m.role === 'tool' && m.toolResults?.length) {
      const replayableResults = m.toolResults.filter(
        (tr) => !discardedToolCallIds.has(tr.toolCallId),
      );
      if (replayableResults.length > 0) {
        sdkMessages.push({
          role: 'tool',
          content: replayableResults.map(tr => {
            const toolCall = toolCallByToolResult.get(tr);
            return {
              type: 'tool-result' as const,
              toolCallId: tr.toolCallId,
              toolName: toolCall?.name ?? 'unknown',
              output: {
                type: 'text' as const,
                value: buildHistoricalToolResultReplayText(tr, toolCall, {
                  preserveTerminalOutput: preserveTerminalToolResults.has(tr),
                }),
              },
            };
          }),
        });
      }
    }
    previousHistoryMessageWasToolResult = m.role === 'tool' && !!m.toolResults?.length
      && m.toolResults.some((tr) => !discardedToolCallIds.has(tr.toolCallId));
  }

  if (includeCurrentUserMessage) {
    if (attachments?.length) {
      const modelText = buildPromptWithTerminalSelectionAttachments(trimmed, attachments);
      const modelAttachments = attachments.filter(
        (attachment) => !isInlineTextAttachment(attachment),
      );
      if (!modelAttachments.length) {
        sdkMessages.push({ role: 'user', content: modelText });
      } else {
        const parts: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string; filename?: string }> = [];
        parts.push({ type: 'text', text: modelText });
        for (const att of modelAttachments) {
          if (att.mediaType.startsWith('image/')) {
            parts.push({ type: 'file', data: att.base64Data, mediaType: att.mediaType });
          } else {
            parts.push({ type: 'file', data: att.base64Data, mediaType: att.mediaType, filename: att.filename });
          }
        }
        sdkMessages.push({ role: 'user', content: parts });
      }
    } else {
      sdkMessages.push({ role: 'user', content: trimmed });
    }
  }

  for (const [message, fields] of nextFieldsByMessage.entries()) {
    fieldsByMessage.set(message, fields);
  }

  return sdkMessages;
}

export function collectToolResultsAfterMessage(
  messages: ChatMessage[],
  messageId: string,
): Set<ToolResult> {
  const results = new Set<ToolResult>();
  let afterMessage = false;
  for (const message of messages) {
    if (message.id === messageId) {
      afterMessage = true;
      continue;
    }
    if (!afterMessage || message.role !== 'tool' || !message.toolResults?.length) continue;
    for (const result of message.toolResults) {
      results.add(result);
    }
  }
  return results;
}

export function collectPreservedTerminalWriteFingerprints(
  messages: ChatMessage[],
  messageId: string,
  chatSessionId: string,
): string[] {
  const preservedResults = collectToolResultsAfterMessage(messages, messageId);
  const { toolCallByToolResult } = buildHistoricalToolReplayMaps(messages);
  const fingerprints: string[] = [];
  for (const result of preservedResults) {
    const call = toolCallByToolResult.get(result);
    if (call?.name !== 'terminal_execute' && call?.name !== 'terminal_start') continue;
    const fingerprint = buildTerminalWriteFingerprint(call.name, chatSessionId, call.arguments);
    if (fingerprint) fingerprints.push(fingerprint);
  }
  return fingerprints;
}

export function createContinuationContext(
  providerConfigId: string,
  providerType: string,
  modelId: string,
  usesOpenAIResponses = false,
): CattyProviderContinuationContext {
  return {
    source: {
      providerConfigId,
      providerType,
      modelId,
    },
    usesOpenAIResponses,
    openAIChatAssistantFields: [],
  };
}

export type { CattyProviderContinuationContext, ProviderContinuation };
