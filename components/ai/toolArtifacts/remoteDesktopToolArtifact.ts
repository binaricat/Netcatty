import {
  summarizeRemoteDesktopActions,
  validateAndNormalizeRemoteDesktopActions,
  type RemoteDesktopAction,
} from '../../../domain/remoteDesktopActionCodec';
import { normalizeArtifactToolName } from './toolArtifactNames';
import { parseResultPayload } from './toolArtifactResultPayload';

export type RemoteDesktopActionVisualKind =
  | 'click'
  | 'drag'
  | 'scroll'
  | 'keyboard'
  | 'wait'
  | 'mixed';

export interface RemoteDesktopArtifactCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RemoteDesktopToolArtifact =
  | {
      kind: 'remoteDesktop.screen';
      sessionId: string;
      captureId?: string;
      protocol?: 'vnc' | 'rdp';
      hostLabel?: string;
      hostname?: string;
      width: number;
      height: number;
      naturalWidth?: number;
      naturalHeight?: number;
      crop?: RemoteDesktopArtifactCrop;
      grid?: boolean;
    }
  | {
      kind: 'remoteDesktop.act';
      sessionId: string;
      captureId?: string;
      protocol?: 'vnc' | 'rdp';
      hostLabel?: string;
      hostname?: string;
      summary: string;
      completedActions: number;
      totalActions: number;
      durationMs?: number;
      actionVisualKind: RemoteDesktopActionVisualKind;
      width?: number;
      height?: number;
      grid?: boolean;
    }
  | {
      kind: 'error';
      toolKind: 'screen' | 'act';
      code?: string;
      message: string;
      completedActions?: number;
      totalActions?: number;
    };

const REMOTE_DESKTOP_READ_SCREEN_TOOL = 'remote_desktop_read_screen';
const REMOTE_DESKTOP_ACT_TOOL = 'remote_desktop_act';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readProtocol(value: unknown): 'vnc' | 'rdp' | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  return lower === 'vnc' || lower === 'rdp' ? lower : undefined;
}

function readCrop(value: unknown): RemoteDesktopArtifactCrop | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = readNumber(record.x);
  const y = readNumber(record.y);
  const width = readNumber(record.width);
  const height = readNumber(record.height);
  if (x == null || y == null || width == null || height == null) return undefined;
  return { x, y, width, height };
}

function classifySingleAction(action: RemoteDesktopAction): Exclude<RemoteDesktopActionVisualKind, 'mixed'> {
  switch (action.type) {
    case 'click':
    case 'move':
      return 'click';
    case 'drag':
      return 'drag';
    case 'scroll':
      return 'scroll';
    case 'type':
    case 'key':
      return 'keyboard';
    case 'wait':
      return 'wait';
  }
}

export function resolveRemoteDesktopActionVisualKind(
  actions?: readonly RemoteDesktopAction[],
  summary?: string,
): RemoteDesktopActionVisualKind {
  if (actions && actions.length > 0) {
    const categories = new Set(actions.map(classifySingleAction));
    // Ignore trailing/intermediate waits when picking the primary visual icon.
    if (categories.size > 1 && categories.has('wait')) {
      categories.delete('wait');
    }
    if (categories.size === 1) {
      return categories.values().next().value!;
    }
    return 'mixed';
  }

  const trimmed = summary?.trim();
  if (!trimmed) return 'click';
  const segments = trimmed.split(/\s*(?:->|→)\s*/).filter(Boolean);
  const categories = new Set<Exclude<RemoteDesktopActionVisualKind, 'mixed'>>();
  for (const seg of segments) {
    if (/^(?:Click|Double-click|Triple-click|Right-click|Middle-click|Move)\b/i.test(seg)) {
      categories.add('click');
    } else if (/^Drag\b/i.test(seg)) {
      categories.add('drag');
    } else if (/^Scroll\b/i.test(seg)) {
      categories.add('scroll');
    } else if (/^(?:Type|Press)\b/i.test(seg)) {
      categories.add('keyboard');
    } else if (/^Wait\b/i.test(seg)) {
      categories.add('wait');
    }
  }
  if (categories.size > 1 && categories.has('wait')) {
    categories.delete('wait');
  }
  if (categories.size === 1) {
    return categories.values().next().value!;
  }
  return categories.size > 1 ? 'mixed' : 'click';
}

export function formatRemoteDesktopActionSummaryText(summary: string): string {
  return summary.replace(/\s*->\s*/g, ' → ');
}

/**
 * Human-readable one-line summary for pending/running/approval remote desktop
 * tool cards before a tool result arrives.
 */
export function extractRemoteDesktopPendingLabel(
  toolName: string,
  args?: Record<string, unknown>,
): { kind: 'screen' | 'act'; label: string } | null {
  const normalized = normalizeArtifactToolName(toolName);
  if (normalized === REMOTE_DESKTOP_ACT_TOOL) {
    const parsed = args ? validateAndNormalizeRemoteDesktopActions(args.actions) : null;
    if (parsed && parsed.ok && parsed.actions.length > 0) {
      return {
        kind: 'act',
        label: formatRemoteDesktopActionSummaryText(
          summarizeRemoteDesktopActions(parsed.actions, { redactSecrets: true }),
        ),
      };
    }
    return { kind: 'act', label: 'remote_desktop_act' };
  }

  if (normalized === REMOTE_DESKTOP_READ_SCREEN_TOOL) {
    const hasCrop = args != null
      && readNumber(args.cropWidth) != null
      && readNumber(args.cropHeight) != null;
    const hasGrid = args?.grid === true || args?.grid === 'true';
    const parts = [
      hasCrop ? 'Read zoomed region' : 'Read remote screen',
      hasGrid ? 'grid' : null,
      readString(args?.quality) === 'high' ? 'high' : null,
    ].filter(Boolean);
    return { kind: 'screen', label: parts.join(' · ') };
  }

  return null;
}

export function parseRemoteDesktopToolArtifact(
  toolName: string,
  result: unknown,
  args?: Record<string, unknown>,
  isError?: boolean,
): RemoteDesktopToolArtifact | null {
  const normalizedToolName = normalizeArtifactToolName(toolName);
  if (
    normalizedToolName !== REMOTE_DESKTOP_READ_SCREEN_TOOL
    && normalizedToolName !== REMOTE_DESKTOP_ACT_TOOL
  ) {
    return null;
  }

  const toolKind = normalizedToolName === REMOTE_DESKTOP_READ_SCREEN_TOOL ? 'screen' : 'act';
  const payload = parseResultPayload(result);

  if (!payload) {
    if (isError) {
      const fallbackMessage = typeof result === 'string' && result.trim()
        ? result.trim()
        : toolKind === 'screen'
          ? 'Remote desktop screen capture failed.'
          : 'Remote desktop action failed.';
      return {
        kind: 'error',
        toolKind,
        message: fallbackMessage,
      };
    }
    return null;
  }

  if (payload.ok === false || payload.isError === true || typeof payload.error === 'string') {
    return {
      kind: 'error',
      toolKind,
      code: readString(payload.code),
      message: readString(payload.error) ?? (
        toolKind === 'screen'
          ? 'Remote desktop screen capture failed.'
          : 'Remote desktop action failed.'
      ),
      completedActions: readNumber(payload.completedActions),
      totalActions: readNumber(payload.totalActions),
    };
  }

  const sessionId = readString(payload.sessionId) ?? readString(args?.sessionId);
  if (!sessionId) return null;

  if (toolKind === 'screen') {
    const width = readNumber(payload.width);
    const height = readNumber(payload.height);
    if (width == null || height == null) return null;

    return {
      kind: 'remoteDesktop.screen',
      sessionId,
      captureId: readString(payload.captureId),
      protocol: readProtocol(payload.protocol),
      hostLabel: readString(payload.hostLabel),
      hostname: readString(payload.hostname),
      width,
      height,
      naturalWidth: readNumber(payload.naturalWidth),
      naturalHeight: readNumber(payload.naturalHeight),
      crop: readCrop(payload.crop),
      grid: payload.grid === true,
    };
  }

  const parsedActions = args ? validateAndNormalizeRemoteDesktopActions(args.actions) : null;
  const actions = parsedActions && parsedActions.ok ? parsedActions.actions : undefined;
  const rawSummary = readString(payload.summary)
    ?? (actions && actions.length > 0
      ? summarizeRemoteDesktopActions(actions, { redactSecrets: true })
      : '');
  const completedActions = readNumber(payload.completedActions) ?? actions?.length ?? 0;
  const totalActions = readNumber(payload.totalActions) ?? completedActions;

  return {
    kind: 'remoteDesktop.act',
    sessionId,
    captureId: readString(payload.captureId),
    protocol: readProtocol(payload.protocol),
    hostLabel: readString(payload.hostLabel),
    hostname: readString(payload.hostname),
    summary: formatRemoteDesktopActionSummaryText(rawSummary),
    completedActions,
    totalActions,
    durationMs: readNumber(payload.durationMs),
    actionVisualKind: resolveRemoteDesktopActionVisualKind(actions, rawSummary),
    width: readNumber(payload.width),
    height: readNumber(payload.height),
    grid: payload.grid === true,
  };
}
