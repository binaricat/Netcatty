import { Check, ShieldAlert, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  onApprovalCleared,
  onApprovalRequest,
  replayPendingApprovals,
  resolveApproval,
  type ApprovalRequest,
} from "../../infrastructure/ai/shared/approvalGate";
import { maskSecretToolArgs } from "../../domain/agentAsset";
import { shouldShowPublicMcpApproval } from "./approvalVisibility";

export interface PublicMcpApprovalPanelViewProps {
  approvals: ApprovalRequest[];
  onApprove: (toolCallId: string) => void;
  onReject: (toolCallId: string) => void;
  className?: string;
}

function summarizeArgs(args: Record<string, unknown>) {
  const command = args.command;
  if (typeof command === "string" && command.trim()) return command;
  const path = args.path;
  if (typeof path === "string" && path.trim()) return path;
  const oldPath = args.oldPath;
  const newPath = args.newPath;
  if (typeof oldPath === "string" && typeof newPath === "string") {
    return `${oldPath} -> ${newPath}`;
  }
  const sessionId = args.sessionId;
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
  return null;
}

export function PublicMcpApprovalPanelView({
  approvals,
  onApprove,
  onReject,
  className,
}: PublicMcpApprovalPanelViewProps) {
  const { t } = useI18n();
  if (approvals.length === 0) return null;

  return (
    <div
      className={cn(
        "fixed top-4 right-4 z-[9998] w-[min(420px,calc(100vw-2rem))] pointer-events-none",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        {approvals.map((approval) => {
          const maskedArgs = maskSecretToolArgs(approval.toolName, approval.args);
          const summary = summarizeArgs(maskedArgs);
          return (
            <section
              key={approval.toolCallId}
              className="pointer-events-auto rounded-md border border-yellow-500/30 bg-background shadow-xl overflow-hidden"
              aria-label={t("ai.publicMcp.approval.title")}
            >
              <div className="flex items-start gap-3 px-3 py-3">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-yellow-500/80" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-sm font-medium truncate">
                      {t("ai.publicMcp.approval.title")}
                    </h2>
                    <Badge
                      variant="outline"
                      className="shrink-0 border-yellow-500/25 text-yellow-500/80 bg-yellow-500/[0.06]"
                    >
                      {t("ai.publicMcp.approval.badge")}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    {t("ai.publicMcp.approval.description")}
                  </p>
                  <div className="mt-2 rounded border border-border/35 bg-muted/20">
                    <div className="px-2.5 py-1.5 border-b border-border/25 font-mono text-xs text-foreground/80 truncate">
                      {approval.toolName}
                    </div>
                    {summary && (
                      <div className="px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/70 truncate">
                        {summary}
                      </div>
                    )}
                    <details className="border-t border-border/25">
                      <summary className="px-2.5 py-1.5 text-[11px] text-muted-foreground/55 cursor-pointer">
                        {t("ai.publicMcp.approval.arguments")}
                      </summary>
                      <pre className="max-h-48 overflow-auto px-2.5 pb-2 text-[11px] font-mono text-muted-foreground/60 whitespace-pre [overflow-wrap:normal]">
                        {JSON.stringify(maskedArgs, null, 2)}
                      </pre>
                    </details>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-border/35 px-3 py-2 bg-muted/10">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs border-red-500/25 text-red-400/90 hover:bg-red-500/10 hover:text-red-400"
                  onClick={() => onReject(approval.toolCallId)}
                >
                  <X size={12} className="mr-1" />
                  {t("ai.chat.reject")}
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs bg-green-600/85 hover:bg-green-600 text-white"
                  onClick={() => onApprove(approval.toolCallId)}
                >
                  <Check size={12} className="mr-1" />
                  {t("ai.chat.approve")}
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function PublicMcpApprovalPanel() {
  const [approvals, setApprovals] = useState<Map<string, ApprovalRequest>>(new Map());

  useEffect(() => {
    const handleRequest = (request: ApprovalRequest) => {
      if (!shouldShowPublicMcpApproval(request.toolCallId, request)) return;
      setApprovals((prev) => new Map(prev).set(request.toolCallId, request));
    };
    const unsubscribeRequest = onApprovalRequest(handleRequest);
    replayPendingApprovals(handleRequest);
    return unsubscribeRequest;
  }, []);

  useEffect(() => {
    return onApprovalCleared((clearedIds) => {
      setApprovals((prev) => {
        const next = new Map(prev);
        for (const id of clearedIds) next.delete(id);
        return next;
      });
    });
  }, []);

  const approvalList = useMemo(() => Array.from(approvals.values()), [approvals]);

  const resolveAndRemove = useCallback((toolCallId: string, approved: boolean) => {
    resolveApproval(toolCallId, approved);
    setApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  return (
    <PublicMcpApprovalPanelView
      approvals={approvalList}
      onApprove={(toolCallId) => resolveAndRemove(toolCallId, true)}
      onReject={(toolCallId) => resolveAndRemove(toolCallId, false)}
    />
  );
}
