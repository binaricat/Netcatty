import { usePluginPermissionPrompt } from '../../application/state/usePluginPermissionPrompt';
import { useI18n } from '../../application/i18n/I18nProvider';
import { describePluginPermission } from '@/domain/pluginPermissionDescriptions.cjs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import globalAgentToolSpecs from '../../infrastructure/ai/harness/generated/globalAgentToolSpecs.json';

/** Rendered only by the trusted app, never inside a plugin view. */
export function PluginPermissionHost() {
  const { resolvedLocale } = useI18n();
  const zh = resolvedLocale.startsWith('zh');
  const { prompt, busy, respond } = usePluginPermissionPrompt();
  if (!prompt) return null;
  const description = describePluginPermission(prompt.permission, resolvedLocale);
  const resources = prompt.resources.filter((resource) => resource !== '*' && !resource.startsWith('selected:'));
  const action = prompt.displayContext?.action;
  const operation = action && (globalAgentToolSpecs.find((tool) => tool.capabilityId === action.capabilityId)?.toolName ?? action.capabilityId);
  const selections = prompt.displayContext?.selections ?? [];
  return <Dialog open onOpenChange={(open) => { if (!open) void respond('cancel'); }}>
    <DialogContent data-host-security-surface="" className="max-h-[85vh] overflow-y-auto sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{description.label}</DialogTitle>
        <DialogDescription className="break-words">{prompt.pluginName ?? prompt.pluginId} · {prompt.pluginVersion}</DialogDescription>
      </DialogHeader>
      <p className="text-sm">{description.description}</p>
      {prompt.displayContext?.modelLabel && <p className="text-sm break-words">{zh ? '模型' : 'Model'}: {prompt.displayContext.modelLabel}</p>}
      {action && <div className="space-y-1">
        <p className="text-sm break-words">{zh ? '操作' : 'Operation'}: <code>{operation}</code>{operation !== action.capabilityId && <> ({action.capabilityId})</>}</p>
        <p className="text-sm">{zh ? '请求内容（控制字符以转义形式显示）' : 'Requested action (control characters shown as escapes)'}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">{action.text}</pre>
      </div>}
      {(selections.length > 0 || prompt.permission === 'ai.agent.actions') && <div className="space-y-1">
        <p className="text-sm">{zh ? '目标' : 'Targets'}:{selections.length === 0 && (zh ? ' 未选择目标' : ' No targets selected')}</p>
        {selections.map((item, index) => <p key={index} className="text-sm break-words">
          {item.title} <span className="text-xs text-muted-foreground">· {item.scope}</span>
        </p>)}
      </div>}
      {(prompt.relatedPermissions ?? []).filter((item, index, items) => items.findIndex((other) => other.permission === item.permission) === index).map((item, index) => <div key={index} className="space-y-1 text-sm">
        <p>{describePluginPermission(item.permission, resolvedLocale).description}</p>
        <p className="text-xs text-muted-foreground break-all">{item.resources.filter((resource) => !resource.startsWith('selected:')).join(', ')}</p>
      </div>)}
      <p className="text-xs text-muted-foreground break-all">{prompt.pluginId}</p>
      {resources.length > 0 && <ul className="max-h-44 overflow-auto space-y-1 text-xs text-muted-foreground">{resources.map((resource) => <li key={resource} className="break-all">{resource}</li>)}</ul>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => void respond('deny')}>{zh ? '拒绝' : 'Deny'}</Button>
        <Button disabled={busy} onClick={() => void respond('allow')}>{prompt.sessionId && prompt.allowedScopes && !prompt.allowedScopes.includes('once') ? zh ? '允许此会话' : 'Allow for this session' : zh ? '允许此次操作' : 'Allow this operation'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
