import type { NetcattyBridge } from '../../../infrastructure/ai/cattyAgent/executor';
import type {
  OpenAIChatAssistantFields,
  ProviderContinuationOptions,
  ProviderContinuationSource,
} from '../../../infrastructure/ai/providerContinuation';

/** Shape of a text/text-delta chunk from the Vercel AI SDK stream. */
export interface TextDeltaChunk {
  type: 'text' | 'text-delta';
  text?: string;
  textDelta?: string;
  providerMetadata?: unknown;
}

/** Shape of a reasoning chunk from the Vercel AI SDK stream. */
export interface ReasoningChunk {
  type: 'reasoning' | 'reasoning-start' | 'reasoning-delta';
  text?: string;
  textDelta?: string;
  delta?: string;
  providerMetadata?: unknown;
}

/** Shape of a raw provider chunk from the Vercel AI SDK stream. */
export interface RawChunk {
  type: 'raw';
  rawValue: unknown;
}

/** Shape of a tool-call chunk from the Vercel AI SDK stream. */
export interface ToolCallChunk {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input?: unknown;
  args?: unknown;
  providerMetadata?: unknown;
}

/** Shape of a tool-result chunk from the Vercel AI SDK stream. */
export interface ToolResultChunk {
  type: 'tool-result';
  toolCallId: string;
  output?: unknown;
  result?: unknown;
}

/** Shape of a tool-error chunk from the Vercel AI SDK stream. */
export interface ToolErrorChunk {
  type: 'tool-error';
  toolCallId: string;
  toolName?: string;
  error?: unknown;
}

/** Shape of a tool-output-denied chunk from the Vercel AI SDK stream. */
export interface ToolOutputDeniedChunk {
  type: 'tool-output-denied';
  toolCallId: string;
  toolName?: string;
}

/** Nested tool call reference on approval stream chunks. */
export interface StreamChunkToolCallRef {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  args?: unknown;
}

/** Shape of a tool-approval-response chunk from the Vercel AI SDK stream. */
export interface ToolApprovalResponseChunk {
  type: 'tool-approval-response';
  approvalId?: string;
  approved?: boolean;
  reason?: string;
  toolCallId?: string;
  toolName?: string;
  toolCall?: StreamChunkToolCallRef;
}

/** Resolve toolCallId from flat or nested approval/tool chunks. */
export function resolveStreamChunkToolCallId(chunk: {
  toolCallId?: string;
  toolCall?: { toolCallId?: string };
}): string | undefined {
  return chunk.toolCallId ?? chunk.toolCall?.toolCallId;
}

/** Format tool execution failures for model/UI consumption. */
export function formatToolErrorContent(error: unknown, fallback = 'Tool execution failed.'): string {
  if (error instanceof Error) return JSON.stringify({ error: error.message });
  if (typeof error === 'string') return JSON.stringify({ error });
  if (error != null && typeof error === 'object' && 'error' in error) {
    return JSON.stringify(error);
  }
  return JSON.stringify({ error: fallback });
}

/** Detect tool results that represent errors/denials (e.g. `{ error: "..." }` or `{ ok: false }`) */
export function isToolResultError(output: unknown): boolean {
  if (output == null) return false;
  
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    // Check for explicit error objects
    if ('error' in obj && typeof obj.error === 'string') return true;
    if ('ok' in obj && obj.ok === false) return true;
  }
  
  // Check stringified JSON (common for tool result wrapping)
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        const parsedObj = parsed as Record<string, unknown>;
        if ('error' in parsedObj && typeof parsedObj.error === 'string') return true;
        if ('ok' in parsedObj && parsedObj.ok === false) return true;
      }
    } catch { /* not JSON, not an error */ }
  }
  
  return false;
}

/** Shape of an error chunk from the Vercel AI SDK stream. */
export interface ErrorChunk {
  type: 'error';
  error: unknown;
}

/** Union of all stream chunk shapes we handle. */
export type StreamChunk =
  | TextDeltaChunk
  | ReasoningChunk
  | ToolCallChunk
  | ToolResultChunk
  | ToolErrorChunk
  | ToolOutputDeniedChunk
  | ToolApprovalResponseChunk
  | ErrorChunk
  | RawChunk
  | { type: 'reasoning-end' | 'text-start' | 'text-end' | 'start' | 'finish' | 'start-step' | 'finish-step' | 'tool-approval-request'; approvalId?: string; toolCallId?: string; toolName?: string; approved?: boolean; toolCall?: StreamChunkToolCallRef; input?: unknown; args?: unknown };

/** Shape of the netcatty bridge exposed on `window` (panel-specific subset). */
export interface PanelBridge extends NetcattyBridge {
  credentialsDecrypt?: (value: string) => Promise<string>;
  aiSyncProviders?: (providers: Array<{ id: string; providerId: string; apiKey?: string; baseURL?: string; enabled: boolean }>) => Promise<{ ok: boolean }>;
  aiSyncWebSearch?: (apiHost: string | null, apiKey: string | null) => Promise<{ ok: boolean }>;
  aiMcpUpdateSessions?: (sessions: TerminalSessionInfo[], chatSessionId?: string) => Promise<unknown>;
  aiMcpUpdateAttachments?: (
    attachments: Array<{ base64Data?: string; mediaType?: string; filename?: string; filePath?: string }>,
    chatSessionId?: string,
  ) => Promise<unknown>;
  aiSdkAgentListModels?: (
    sdkBackend: string,
    cwd?: string,
    providerId?: string,
    chatSessionId?: string,
    agentEnv?: Record<string, string>,
    agentCommand?: string,
  ) => Promise<{ ok: boolean; models?: Array<{ id: string; name: string; description?: string; thinkingLevels?: string[] }>; currentModelId?: string | null; error?: string }>;
  aiCattyCancelExec?(chatSessionId: string): Promise<unknown>;
  aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
  aiMcpSyncPermissionGrants?(grants: Array<Record<string, unknown>>): Promise<{ ok: boolean; count?: number; error?: string }>;
  aiSdkAgentCancel?: (requestId: string, chatSessionId?: string) => Promise<{ ok: boolean; error?: string }>;
  aiSdkAgentCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  aiUserSkillsGetStatus?: () => Promise<{
    ok: boolean;
    skills?: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      status: 'ready' | 'warning';
    }>;
  }>;
  aiUserSkillsBuildContext?: (prompt: string, selectedSkillSlugs?: string[]) => Promise<{ ok: boolean; context?: string; error?: string }>;
  [key: string]: ((...args: unknown[]) => unknown) | undefined;
}

/** Terminal session info used throughout the streaming hooks. */
export interface TerminalSessionInfo {
  sessionId: string;
  hostId: string;
  hostname: string;
  label: string;
  os?: string;
  username?: string;
  protocol?: string;
  shellType?: string;
  deviceType?: string;
  connected: boolean;
  hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
  activePortForwards?: Array<{
    ruleId: string;
    label?: string;
    type?: string;
    localPort?: number;
    status?: string;
  }>;
}

export interface DefaultTargetSessionHint extends TerminalSessionInfo {
  source: 'scope-target' | 'only-connected-in-scope';
}

export interface CattyProviderContinuationContext {
  source: ProviderContinuationSource;
  openAIChatAssistantFields: Array<OpenAIChatAssistantFields | undefined>;
}

export type AssistantContentPart =
  | { type: 'reasoning'; text: string; providerOptions?: ProviderContinuationOptions }
  | { type: 'text'; text: string; providerOptions?: ProviderContinuationOptions }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerOptions?: ProviderContinuationOptions };

export function toAssistantModelContent(parts: AssistantContentPart[]): string | AssistantContentPart[] {
  if (parts.length === 1 && parts[0].type === 'text' && !parts[0].providerOptions) {
    return parts[0].text;
  }
  return parts;
}

/** Typed accessor for the netcatty bridge on the window object. */
export function getNetcattyBridge(): PanelBridge | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).netcatty as PanelBridge | undefined;
}

// ApprovalInfo and PendingApprovalContext removed — approval is now handled
// inside the tool's execute function via the approvalGate module.

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const USER_SKILLS_CONTEXT_TIMEOUT_MS = 500;

interface UserSkillsContextResult {
  ok: boolean;
  context?: string;
  error?: string;
}

function buildExplicitUserSkillsFallback(selectedUserSkillSlugs?: string[]): string {
  if (!selectedUserSkillSlugs?.length) return '';
  return `The user explicitly selected these Netcatty user skills for this request: ${selectedUserSkillSlugs.map((slug) => `/${slug}`).join(', ')}. Honor those selections even if their expanded skill content is unavailable.`;
}

export async function resolveUserSkillsContext(
  bridge: PanelBridge | undefined,
  prompt: string,
  selectedUserSkillSlugs?: string[],
): Promise<string> {
  if (!bridge?.aiUserSkillsBuildContext) {
    return buildExplicitUserSkillsFallback(selectedUserSkillSlugs);
  }

  const buildContextPromise: Promise<UserSkillsContextResult> = bridge
    .aiUserSkillsBuildContext(prompt, selectedUserSkillSlugs)
    .catch(() => ({ ok: false, context: '' }));

  const hasExplicitSelections = (selectedUserSkillSlugs?.length ?? 0) > 0;
  const result = hasExplicitSelections
    ? await buildContextPromise
    : await Promise.race([
        buildContextPromise,
        new Promise<UserSkillsContextResult>((resolve) =>
          setTimeout(() => resolve({ ok: false, context: '' }), USER_SKILLS_CONTEXT_TIMEOUT_MS),
        ),
      ]);

  return result.context || buildExplicitUserSkillsFallback(selectedUserSkillSlugs);
}
