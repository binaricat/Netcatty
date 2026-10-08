import { z } from 'zod';
import type { NetcattyBridge } from '../cattyAgent/executor';
import type { ExecutorContext } from '../cattyAgent/executor';
import type { AIPermissionMode, WebSearchConfig } from '../types';
import type { ToolOutputStore } from './toolOutputStore';
import type { SessionStateStore } from './sessionState';
import type { ToolResultDedup } from './toolResultDedup';
import type { CompactionTrace } from './types';
import type { AgentKind } from '../agentKinds';
import type { PromptContextSnapshot } from './promptContextSnapshot';

export const cattyRuntimeContextSchema = z.object({
  chatSessionId: z.string(),
  turnId: z.string(),
  agentKind: z.enum(['sidebar', 'global']),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  userGoal: z.string().optional(),
  permissionMode: z.enum(['observer', 'confirm', 'auto']),
  scopeType: z.enum(['terminal', 'workspace']),
  scopeLabel: z.string().optional(),
  lastCompaction: z.custom<CompactionTrace>().optional(),
  lastStepAdjusted: z.boolean().optional(),
  promptContext: z.custom<PromptContextSnapshot>().optional(),
});

export type CattyRuntimeContext = z.infer<typeof cattyRuntimeContextSchema>;

export const cattyToolContextSchema = z.object({
  bridge: z.custom<NetcattyBridge>(),
  chatSessionId: z.string().optional(),
  permissionMode: z.enum(['observer', 'confirm', 'auto']),
  commandBlocklist: z.array(z.string()).optional(),
  webSearchConfig: z.custom<WebSearchConfig>().optional(),
  getExecutorContext: z.custom<() => ExecutorContext>(),
  toolOutputStore: z.custom<ToolOutputStore>().optional(),
  toolResultDedup: z.custom<ToolResultDedup>().optional(),
  // Tracks jobs inherited from a branched source chat, so a background job's
  // stop call can be dispatched with the owner chat session id as a fallback
  // when the branch's inheritor registration is missing (see
  // SessionStateStore.getInheritedJobOwnerChatSessionId). Polls must keep the
  // branch's own id so the main process validates the branch's current scope.
  sessionStateStore: z.custom<SessionStateStore>().optional(),
});

export type CattyToolContext = z.infer<typeof cattyToolContextSchema>;

export function createInitialCattyRuntimeContext(input: {
  chatSessionId: string;
  turnId: string;
  agentKind?: AgentKind;
  providerId?: string;
  modelId?: string;
  userGoal?: string;
  permissionMode: AIPermissionMode;
  scopeType: 'terminal' | 'workspace';
  scopeLabel?: string;
  promptContext?: PromptContextSnapshot;
}): CattyRuntimeContext {
  return {
    chatSessionId: input.chatSessionId,
    turnId: input.turnId,
    agentKind: input.agentKind ?? 'sidebar',
    providerId: input.providerId,
    modelId: input.modelId,
    userGoal: input.userGoal,
    permissionMode: input.permissionMode,
    scopeType: input.scopeType,
    scopeLabel: input.scopeLabel,
    promptContext: input.promptContext,
  };
}

export function toolDepsFromContext(context: CattyToolContext): import('../shared/toolExecutors').ToolDeps {
  return {
    bridge: context.bridge,
    context: context.getExecutorContext,
    commandBlocklist: context.commandBlocklist,
    permissionMode: context.permissionMode,
    webSearchConfig: context.webSearchConfig,
    chatSessionId: context.chatSessionId,
  };
}
