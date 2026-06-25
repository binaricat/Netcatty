import { compressVerboseText, truncateTextWithHeadAndTail } from '../requestPayloadCompression';
import type { ToolOutputStore } from './toolOutputStore';

export const MAX_LIVE_TOOL_STRING_CHARS = 8_000;

export interface FitLargeToolResultForModelInput {
  result: unknown;
  capabilityId: string;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  maxStringChars?: number;
}

export function fitLargeToolResultForModel({
  result,
  capabilityId,
  chatSessionId,
  toolOutputStore,
  maxStringChars = MAX_LIVE_TOOL_STRING_CHARS,
}: FitLargeToolResultForModelInput): unknown {
  return fitValue(result, {
    capabilityId,
    chatSessionId,
    toolOutputStore,
    maxStringChars,
    path: [],
  });
}

interface FitValueContext {
  capabilityId: string;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  maxStringChars: number;
  path: string[];
}

function fitValue(value: unknown, ctx: FitValueContext): unknown {
  if (typeof value === 'string') {
    return fitString(value, ctx);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      const fitted = fitValue(entry, {
        ...ctx,
        path: [...ctx.path, `[${index}]`],
      });
      if (fitted !== entry) changed = true;
      return fitted;
    });
    return changed ? next : value;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fitted = fitValue(entry, {
      ...ctx,
      path: [...ctx.path, key],
    });
    if (fitted !== entry) changed = true;
    next[key] = fitted;
  }

  return changed ? next : value;
}

function fitString(value: string, ctx: FitValueContext): string {
  if (value.length <= ctx.maxStringChars) return value;

  const fitted = truncateTextWithHeadAndTail(
    compressVerboseText(value),
    ctx.maxStringChars,
  );
  if (fitted === value) return value;

  let handleId: string | undefined;
  if (ctx.toolOutputStore && ctx.chatSessionId) {
    handleId = ctx.toolOutputStore.store({
      chatSessionId: ctx.chatSessionId,
      capabilityId: ctx.capabilityId,
      content: value,
    }).id;
  }

  return appendToolOutputHandleNotice(fitted, {
    capabilityId: ctx.capabilityId,
    fieldPath: formatFieldPath(ctx.path),
    totalChars: value.length,
    handleId,
  });
}

function formatFieldPath(path: string[]): string {
  if (path.length === 0) return '$';
  return path
    .map((part, index) => {
      if (part.startsWith('[')) return part;
      return index === 0 ? part : `.${part}`;
    })
    .join('');
}

function appendToolOutputHandleNotice(
  fitted: string,
  details: {
    capabilityId: string;
    fieldPath: string;
    totalChars: number;
    handleId?: string;
  },
): string {
  const handleSuffix = details.handleId ? ` handleId=${details.handleId}` : '';
  return `${fitted}\n\n[tool output handle: capability=${details.capabilityId} field=${details.fieldPath} chars=${details.totalChars} truncated for model context${handleSuffix}]`;
}
