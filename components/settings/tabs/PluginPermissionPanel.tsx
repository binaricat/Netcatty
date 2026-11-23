import React, { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { describePluginPermission } from '@/domain/pluginPermissionDescriptions.cjs';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { SettingRow } from '../settings-ui';

/** Host UI only. Plugin views cannot query or mutate this security state. */
export function PluginPermissionPanel({ pluginId, onChanged, actions }: {
  pluginId: string;
  onChanged: () => Promise<void>;
  actions?: React.ReactNode;
}) {
  const { t, resolvedLocale } = useI18n();
  const [snapshot, setSnapshot] = useState<NetcattyPluginPermissionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const refresh = useCallback(async (preserveError = false) => {
    const current = ++generation.current;
    if (!preserveError) setError(null);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.getPluginPermissions) throw new Error(t('settings.plugins.permissions.unavailable'));
      const result = await bridge.getPluginPermissions(pluginId);
      if (current === generation.current) setSnapshot(result);
    } catch (cause) {
      if (current === generation.current) {
        setSnapshot(null);
        const message = cause instanceof Error ? cause.message : String(cause);
        setError((previous) => preserveError && previous ? `${previous}\n${message}` : message);
      }
    }
  }, [pluginId, t]);
  useEffect(() => {
    const requestGeneration = generation;
    void refresh();
    return () => { requestGeneration.current++; };
  }, [refresh]);
  const changeMode = async (permission: string, mode: PluginPermissionMode) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.setPluginPermissionMode || !snapshot?.policyRevision) throw new Error(t('settings.plugins.permissions.unavailable'));
      await bridge.setPluginPermissionMode(pluginId, permission, mode, snapshot.policyRevision);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { await refresh(true); pending.current = false; setBusy(false); }
  };
  const revoke = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.revokePluginPermissions) throw new Error(t('settings.plugins.permissions.unavailable'));
      await bridge.revokePluginPermissions(pluginId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await onChanged(); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError((previous) => previous ? `${previous}\n${message}` : message);
      }
      await refresh(true);
      pending.current = false; setBusy(false);
    }
  };
  return <section data-host-security-surface="" className="space-y-3 border-t border-border/60 pt-4 text-sm" aria-label={t('settings.plugins.permissions.title')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{t('settings.plugins.permissions.title')}</h4>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>{t('settings.plugins.permissions.refresh')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('settings.plugins.permissions.note')}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!snapshot && !error && <p role="status">{t('settings.plugins.permissions.loading')}</p>}
    {snapshot && <>
      {(snapshot.policies ?? []).map((policy) => <SettingRow key={policy.permission}
        label={describePluginPermission(policy.permission, resolvedLocale).label}
        description={<span className="whitespace-pre-wrap break-all">{describePluginPermission(policy.permission, resolvedLocale).description}{' · '}{policy.resources.join(', ')}</span>}>
        <Select value={policy.mode} disabled={busy} onValueChange={(mode) => void changeMode(policy.permission, mode as PluginPermissionMode)}>
          <SelectTrigger className="w-28" aria-label={describePluginPermission(policy.permission, resolvedLocale).label}><SelectValue /></SelectTrigger>
          <SelectContent>{(['allow', 'ask', 'deny'] as const).map((mode) => <SelectItem key={mode} value={mode}>{t(`settings.plugins.permissions.${mode}`)}</SelectItem>)}</SelectContent>
        </Select>
      </SettingRow>)}
      {snapshot.grants.length === 0 && <p className="text-xs text-muted-foreground">{t('settings.plugins.permissions.empty')}</p>}
      {snapshot.grants.map((grant, index) => <div key={index} className="rounded-md bg-muted/40 p-3 text-xs">
        <p className="font-medium">{describePluginPermission(grant.permission, resolvedLocale).label}</p>
        <p className="whitespace-pre-wrap break-all font-mono">{grant.resource}</p>
        <p>{t(grant.matchesCurrentActivation ? 'settings.plugins.permissions.current' : 'settings.plugins.permissions.inactive')}</p>
        <p>{t(`settings.plugins.permissions.${grant.scope}`)}{grant.sessionId ? ` · ${grant.sessionId}` : ''}</p>
        <time dateTime={new Date(grant.grantedAt).toISOString()}>{new Date(grant.grantedAt).toLocaleString(resolvedLocale)}</time>
      </div>)}
      <details className="text-xs">
        <summary className="cursor-pointer">{t('settings.plugins.permissions.audit')}</summary>
        <ol className="mt-2 space-y-1">{snapshot.audit.map((entry, index) => <li key={index} className="break-words">
          <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString(resolvedLocale)}</time>{' · '}
          {entry.event}{entry.permission ? ` · ${entry.permission}` : ''}{entry.scope ? ` · ${entry.scope}` : ''}{entry.mode ? ` · ${t(`settings.plugins.permissions.${entry.mode}`)}` : ''}{entry.action ? ` · ${entry.action}` : ''}
        </li>)}</ol>
      </details>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.permissions.revokeNote')}</p>
    </>}
    <div className="flex flex-wrap items-center gap-2">
      {snapshot && <Button variant="secondary" size="sm" className="bg-amber-500 text-amber-950 hover:bg-amber-400" disabled={busy} onClick={() => void revoke()}>{t('settings.plugins.permissions.revoke')}</Button>}
      {actions}
    </div>
  </section>;
}
