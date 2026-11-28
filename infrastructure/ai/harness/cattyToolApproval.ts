import type { ToolApprovalConfiguration } from 'ai';
import { findHighRiskRemoteDesktopActionsFromInput } from '../../../domain/remoteDesktopActionCodec';
import type { AIPermissionMode } from '../types';
import type { PluginDynamicToolPolicy } from '../pluginAiSidebarTypes';
import { requestApproval as defaultRequestApproval } from '../shared/approvalGate';
import {
  HIGH_RISK_REMOTE_DESKTOP_CAPABILITY_ID,
  resolveCapabilityId,
} from './permissionGrants';
import cattyToolSpecs from './generated/cattyToolSpecs.json';

type CattyToolPolicySpec = {
  toolName: string;
  capabilityId: string;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
    bypassesObserverBlock?: boolean;
  };
};

const policyByToolName = new Map<string, CattyToolPolicySpec>(
  (cattyToolSpecs as CattyToolPolicySpec[]).map((spec) => [spec.toolName, spec]),
);

function needsUserApproval(
  toolName: string,
  permissionMode: AIPermissionMode,
  dynamicToolPolicies?: ReadonlyMap<string, PluginDynamicToolPolicy>,
): boolean {
  if (permissionMode !== 'confirm') return false;
  const spec = policyByToolName.get(toolName);
  if (spec) {
    return spec.policy.write && !spec.policy.bypassesApproval;
  }
  const dynamic = dynamicToolPolicies?.get(toolName);
  return Boolean(dynamic?.write);
}

export function buildCattyToolApproval(input: {
  permissionMode: AIPermissionMode;
  chatSessionId?: string;
  dynamicToolPolicies?: ReadonlyMap<string, PluginDynamicToolPolicy>;
  requestApproval?: typeof defaultRequestApproval;
}): ToolApprovalConfiguration<Record<string, never>, import('./cattyRuntimeContext').CattyRuntimeContext> {
  const {
    permissionMode,
    chatSessionId,
    dynamicToolPolicies,
    requestApproval = defaultRequestApproval,
  } = input;

  return async ({ toolCall }) => {
    const spec = policyByToolName.get(toolCall.toolName);
    const dynamicPolicy = !spec ? dynamicToolPolicies?.get(toolCall.toolName) : undefined;
    const isWrite = Boolean(spec?.policy.write || dynamicPolicy?.write);
    if (!isWrite) {
      return undefined;
    }

    if (permissionMode === 'observer' && !spec?.policy.bypassesObserverBlock) {
      return { type: 'denied' as const, reason: 'Observer mode blocks write operations.' };
    }

    const args = (toolCall.input ?? {}) as Record<string, unknown>;
    const isRemoteDesktopAct =
      toolCall.toolName === 'remote_desktop_act'
      || spec?.capabilityId === 'harness.remote_desktop.act';
    const highRiskMatches = isRemoteDesktopAct
      ? findHighRiskRemoteDesktopActionsFromInput(args)
      : [];
    const requiresFreshHighRiskApproval = highRiskMatches.length > 0;

    if (!requiresFreshHighRiskApproval && !needsUserApproval(toolCall.toolName, permissionMode, dynamicToolPolicies)) {
      return undefined;
    }

    const approved = await requestApproval(
      toolCall.toolCallId,
      toolCall.toolName,
      args,
      chatSessionId,
      undefined,
      requiresFreshHighRiskApproval
        ? HIGH_RISK_REMOTE_DESKTOP_CAPABILITY_ID
        : (spec?.capabilityId ?? dynamicPolicy?.capabilityId ?? resolveCapabilityId(toolCall.toolName)),
    );

    if (approved) {
      return { type: 'approved' as const };
    }
    return { type: 'denied' as const, reason: 'User denied tool execution.' };
  };
}
