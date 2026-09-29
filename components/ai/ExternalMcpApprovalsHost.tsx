/**
 * Always-mounted host for External MCP approval cards.
 * Confirm-mode write tools from Codex/Claude/Cursor/Grok must be approvable
 * even when the Catty AI side panel has never been opened.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ToolCall } from '../ai-elements/tool-call';
import { Button } from '../ui/button';
import {
  onApprovalCleared,
  onApprovalRequest,
  replayPendingApprovals,
  resolveApproval,
  type ApprovalRequest,
} from '../../infrastructure/ai/shared/approvalGate';
import {
  buildGrantsFromApproval,
  createPermissionGrantId,
  resolveCapabilityId,
} from '../../infrastructure/ai/harness/permissionGrants';
import { useI18n } from '../../application/i18n/I18nProvider';

const EXTERNAL_MCP_CHAT_SESSION_ID = '__external_mcp__';

function isExternalMcpApproval(request: ApprovalRequest): boolean {
  return request.toolCallId.startsWith('mcp_approval_')
    && request.chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID;
}

export const ExternalMcpApprovalsHost: React.FC = () => {
  const { t } = useI18n();
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, ApprovalRequest>>(new Map());

  useEffect(() => {
    const handler = (request: ApprovalRequest) => {
      if (!isExternalMcpApproval(request)) return;
      setPendingApprovals((prev) => new Map(prev).set(request.toolCallId, request));
    };
    const unsub = onApprovalRequest(handler);
    replayPendingApprovals(handler);
    return unsub;
  }, []);

  useEffect(() => {
    return onApprovalCleared((clearedIds) => {
      setPendingApprovals((prev) => {
        const next = new Map(prev);
        for (const id of clearedIds) next.delete(id);
        return next;
      });
    });
  }, []);

  const handleApproveOnce = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, true);
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleAlwaysAllow = useCallback((toolCallId: string, request: ApprovalRequest) => {
    const capabilityId = request.capabilityId ?? resolveCapabilityId(request.toolName);
    const persistGrants = buildGrantsFromApproval(capabilityId, request.args, request.chatSessionId)
      .map((grant) => request.target?.hostId
        ? { ...grant, sessionPattern: `host:${request.target.hostId}` }
        : grant);
    resolveApproval(toolCallId, { approved: true, persistGrants });
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleAllowSession = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, { approved: true, scope: 'session' });
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleAllowHost = useCallback((toolCallId: string, request: ApprovalRequest) => {
    const hostId = request.target?.hostId;
    if (!hostId) return;
    resolveApproval(toolCallId, {
      approved: true,
      persistGrant: {
        id: createPermissionGrantId(),
        capabilityId: '*',
        sessionPattern: `host:${hostId}`,
        createdAt: Date.now(),
        note: request.target?.label,
      },
    });
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleReject = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, false);
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const entries = Array.from(pendingApprovals.entries());
  if (entries.length === 0) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-4 right-4 z-[80] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
      data-testid="external-mcp-approvals-host"
    >
      <div className="rounded-lg border border-border/60 bg-background/95 p-3 shadow-lg backdrop-blur-sm">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {t('ai.externalMcp.title')}
        </div>
        <div className="space-y-2">
          {entries.map(([id, req]) => (
            <div key={id} className="space-y-1.5">
              <ToolCall
                name={req.toolName}
                args={req.args}
                approvalTarget={req.target}
                isLoading={false}
                isInterrupted={false}
                approvalStatus="pending"
                approvalId={id}
                onApproveOnce={() => handleApproveOnce(id)}
                onAlwaysAllow={req.target && !req.target.hostId ? undefined : () => handleAlwaysAllow(id, req)}
                onReject={() => handleReject(id)}
                alwaysAllowLabel={req.target?.hostId ? t('ai.externalMcp.allowCommandOnHost') : undefined}
              />
              {(req.allowSession || req.target?.hostId) && (
                <div className="flex flex-wrap gap-1.5">
                  {req.allowSession && (
                    <Button variant="outline" size="sm" onClick={() => handleAllowSession(id)}>
                      {t('ai.externalMcp.allowSession')}
                    </Button>
                  )}
                  {req.target?.hostId && (
                    <Button variant="outline" size="sm" onClick={() => handleAllowHost(id, req)}>
                      {t('ai.externalMcp.allowHost')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
