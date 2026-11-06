import React, { useState } from 'react';
import { usePluginLogs } from '../../../application/state/usePluginLogs';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../ui/dialog';
import { SettingRow, Toggle } from '../settings-ui';

/** Host settings row; detailed controls stay inside the standard host dialog. */
export function PluginLogSettings() {
  const { t, resolvedLocale } = useI18n();
  const zh = resolvedLocale.startsWith('zh');
  const { status, error, busy, run } = usePluginLogs();
  const [open, setOpen] = useState(false);
  const [confirmVerbose, setConfirmVerbose] = useState(false);
  const title = zh ? '本地插件日志' : 'Local plugin logs';
  const saveLabel = zh ? '将宿主审计日志保存到本地' : 'Save host audit logs locally';
  const verboseLabel = zh ? '包含插件详细诊断文字' : 'Include verbose plugin text';
  const disclosure = zh
    ? '插件编写的日志文字可能包含敏感数据。截断和字段过滤不能保证任意文字安全。只为排查问题临时开启，导出前请检查。重启应用后自动关闭详细日志。'
    : 'Plugin-authored text may contain sensitive data. Truncation and field filtering cannot make arbitrary text safe. Enable temporarily for troubleshooting and review files before sharing. Verbose diagnostics turn off after app restart.';
  return <div>
    <Dialog open={open} onOpenChange={setOpen}>
      <SettingRow label={title} description={zh ? '选择是否在此设备保存审计记录和诊断日志。' : 'Choose whether to keep audit records and diagnostics on this device.'}>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" role="status">{status ? (status.saveToDisk ? t('common.enabled') : t('common.disabled')) : error ? (zh ? '不可用' : 'Unavailable') : (zh ? '载入中' : 'Loading')}</span>
          <DialogTrigger asChild><Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="outline" size="sm">{zh ? '配置' : 'Configure'}</Button></DialogTrigger>
        </div>
      </SettingRow>
      <DialogContent data-host-security-surface="" className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{zh ? '默认不保存。仅保存在此设备，不上传或同步。权限面板中的有限安全历史独立保留。' : 'Saving is off by default. Files stay on this device with no upload or sync. The bounded security history in plugin permissions is separate.'}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="divide-y divide-border">
          <SettingRow label={saveLabel} description={zh ? '保存宿主确认的操作和授权结果，不保存敏感正文。' : 'Save host-observed operations and authorization outcomes without sensitive bodies.'}>
            <Toggle ariaLabel={saveLabel} checked={status?.saveToDisk ?? false} disabled={busy || !status} onChange={(saveToDisk) => void run('configure', { saveToDisk, verbose: false })} />
          </SettingRow>
          <SettingRow label={verboseLabel} description={zh ? '插件文字可能包含敏感数据；只为排查问题临时开启。' : 'Plugin text may contain sensitive data. Enable temporarily for troubleshooting.'}>
            <Toggle ariaLabel={verboseLabel} checked={status?.verbose ?? false} disabled={busy || !status?.saveToDisk} onChange={(verbose) => verbose ? setConfirmVerbose(true) : void run('configure', { saveToDisk: true, verbose: false })} />
          </SettingRow>
        </div>
        {status && <p className="text-xs text-muted-foreground">{zh ? `最多 ${status.maxBytes / 1048576} MiB，最长保留 ${status.retentionDays} 天。丢弃 ${status.droppedRecords} 条，写入错误 ${status.writeErrors} 次。` : `Up to ${status.maxBytes / 1048576} MiB, up to ${status.retentionDays} days. Dropped: ${status.droppedRecords}. Write errors: ${status.writeErrors}.`}</p>}
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="outline" size="sm" disabled={busy || !status} onClick={() => void run('open')}>{zh ? '打开文件夹' : 'Open folder'}</Button>
            <Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="outline" size="sm" disabled={busy || !status} onClick={() => void run('export')}>{zh ? '导出' : 'Export'}</Button>
            <Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="ghost" size="sm" disabled={busy || !status} onClick={() => void run('clear')}>{zh ? '清除日志…' : 'Clear logs…'}</Button>
            <Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="ghost" size="sm" disabled={busy} onClick={() => void run('status')}>{zh ? '刷新' : 'Refresh'}</Button>
          </div>
          <Button className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" variant="outline" size="sm" onClick={() => setOpen(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog hostSecuritySurface open={confirmVerbose} title={zh ? '开启插件详细诊断？' : 'Enable verbose plugin diagnostics?'} message={disclosure} confirmLabel={zh ? '临时开启' : 'Enable temporarily'} onOpenChange={setConfirmVerbose} onConfirm={() => { setConfirmVerbose(false); void run('configure', { saveToDisk: true, verbose: true }); }} />
  </div>;
}
