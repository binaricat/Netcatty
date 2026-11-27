import type { ApprovalRequest } from '../../infrastructure/ai/shared/approvalGate';
import toolNameIndex from '../../infrastructure/ai/harness/generated/toolNameIndex.json';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  readExternalMcpApprovalAlertMode,
  type ExternalMcpApprovalAlertMode,
} from './useExternalMcpToggleState';

const mcpToolNameByRpcMethod = toolNameIndex.sidebarByRpcMethod as Record<string, string>;

/**
 * Name shown on the External MCP approval card.
 * Catalog MCP tool names win over internal RPC ids such as `netcatty/exec`.
 * An id with no catalog tool name is shown as-is.
 */
export function externalMcpApprovalToolLabel(toolName: string | undefined): string {
  const raw = toolName?.trim() || '';
  if (!raw) return '';
  return mcpToolNameByRpcMethod[raw] || raw;
}

export type ExternalMcpApprovalNotification = {
  title: string;
  body: string;
  dedupeKey: string;
  whenUnfocused: boolean;
};

type Translate = (
  key: string,
  values?: Record<string, string | number | boolean | null | undefined>,
) => string;

/**
 * Build the system notification for one External MCP approval.
 * Returns null when the preference is off. Focus gating stays in the main
 * process so every Netcatty window is considered, not only the sender.
 */
export function presentExternalMcpApprovalNotification(options: {
  toolName: string;
  hostLabel?: string;
  dedupeKey: string;
  mode: ExternalMcpApprovalAlertMode;
  t: Translate;
  notify: (payload: ExternalMcpApprovalNotification) => void;
}): boolean {
  if (options.mode === 'off') return false;
  const tool = externalMcpApprovalToolLabel(options.toolName);
  const host = options.hostLabel?.trim() || '';
  const body = host
    ? options.t('ai.externalMcp.approvalAlert.notificationBodyOnHost', { tool, host })
    : options.t('ai.externalMcp.approvalAlert.notificationBody', { tool });
  options.notify({
    title: options.t('ai.externalMcp.approvalAlert.notificationTitle'),
    body,
    dedupeKey: options.dedupeKey,
    whenUnfocused: options.mode === 'unfocused',
  });
  return true;
}

export function publishExternalMcpApprovalAlertMode(): void {
  void netcattyBridge.get()?.setExternalMcpApprovalAlertMode?.({
    mode: readExternalMcpApprovalAlertMode(),
  });
}

export function notifyExternalMcpApproval(
  request: Pick<ApprovalRequest, 'toolName' | 'toolCallId' | 'target'>,
  t: Translate,
): boolean {
  return presentExternalMcpApprovalNotification({
    toolName: request.toolName,
    hostLabel: request.target?.label || request.target?.hostname || '',
    dedupeKey: request.toolCallId,
    mode: readExternalMcpApprovalAlertMode(),
    t,
    notify: (payload) => {
      void netcattyBridge.get()?.showSystemNotification?.(payload);
    },
  });
}
