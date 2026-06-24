/**
 * SettingsFileAssociationsTab - Manage SFTP file opener associations and behavior
 */
import { FileType, Pencil, Trash2 } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { useSftpFileAssociations } from "../../../application/state/useSftpFileAssociations";
import { useSettingsState } from "../../../application/state/useSettingsState";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import {
  SectionHeader,
  SettingCard,
  SettingsTabContent,
  SettingRow,
  Toggle,
  Select,
} from "../settings-ui";

const getOpenerLabel = (
  openerType: FileOpenerType,
  systemApp: SystemAppInfo | undefined,
  t: (key: string) => string
): string => {
  if (openerType === 'builtin-editor') {
    return t('sftp.opener.builtInEditor');
  } else if (openerType === 'system-app' && systemApp) {
    return systemApp.name;
  }
  return openerType;
};

export default function SettingsFileAssociationsTab() {
  const { t } = useI18n();
  const { getAllAssociations, removeAssociation, setOpenerForExtension, getDefaultOpener, setDefaultOpener, removeDefaultOpener } = useSftpFileAssociations();
  const { sftpDoubleClickBehavior, setSftpDoubleClickBehavior, sftpAutoSync, setSftpAutoSync, sftpShowHiddenFiles, setSftpShowHiddenFiles, sftpUseCompressedUpload, setSftpUseCompressedUpload, sftpAutoOpenSidebar, setSftpAutoOpenSidebar, sftpFollowTerminalCwd, setSftpFollowTerminalCwd, sftpDefaultViewMode, setSftpDefaultViewMode, sftpTransferConcurrency, setSftpTransferConcurrency } = useSettingsState();
  const associations = getAllAssociations();
  const defaultOpener = getDefaultOpener();
  const [editingExtension, setEditingExtension] = useState<string | null>(null);
  const [isSelectingDefaultApp, setIsSelectingDefaultApp] = useState(false);

  const defaultOpenerValue = useMemo(() => {
    if (!defaultOpener) return 'ask';
    if (defaultOpener.openerType === 'builtin-editor') return 'builtin-editor';
    return 'system-app';
  }, [defaultOpener]);

  const handleRemove = useCallback((extension: string) => {
    if (confirm(t('settings.sftpFileAssociations.removeConfirm', { ext: extension === 'file' ? t('sftp.opener.noExtension') : extension }))) {
      removeAssociation(extension);
    }
  }, [removeAssociation, t]);

  const handleSelectDefaultSystemApp = useCallback(async () => {
    setIsSelectingDefaultApp(true);
    try {
      const bridge = netcattyBridge.get();
      if (!bridge?.selectApplication) return;
      const result = await bridge.selectApplication();
      if (result) {
        setDefaultOpener('system-app', { path: result.path, name: result.name });
      }
    } catch (e) {
      console.error('Failed to select application:', e);
    } finally {
      setIsSelectingDefaultApp(false);
    }
  }, [setDefaultOpener]);

  const handleDefaultOpenerChange = useCallback((value: string) => {
    if (value === 'ask') {
      removeDefaultOpener();
      return;
    }
    if (value === 'builtin-editor') {
      setDefaultOpener('builtin-editor');
      return;
    }
    void handleSelectDefaultSystemApp();
  }, [handleSelectDefaultSystemApp, removeDefaultOpener, setDefaultOpener]);

  const handleEdit = useCallback(async (extension: string) => {
    setEditingExtension(extension);
    try {
      const bridge = netcattyBridge.get();
      if (!bridge?.selectApplication) {
        return;
      }
      const result = await bridge.selectApplication();
      if (result) {
        setOpenerForExtension(extension, 'system-app', { path: result.path, name: result.name });
      }
    } catch (e) {
      console.error('Failed to select application:', e);
    } finally {
      setEditingExtension(null);
    }
  }, [setOpenerForExtension]);

  return (
    <SettingsTabContent value="file-associations">
      <SectionHeader title={t('settings.sftp.doubleClickBehavior')} />
      <SettingCard>
        <SettingRow description={t('settings.sftp.doubleClickBehavior.desc')}>
          <Select
            value={sftpDoubleClickBehavior}
            options={[
              { value: 'open', label: t('settings.sftp.doubleClickBehavior.open') },
              { value: 'transfer', label: t('settings.sftp.doubleClickBehavior.transfer') },
            ]}
            onChange={(value) => setSftpDoubleClickBehavior(value as 'open' | 'transfer')}
            className="w-48"
          />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.defaultViewMode')} />
      <SettingCard>
        <SettingRow description={t('settings.sftp.defaultViewMode.desc')}>
          <Select
            value={sftpDefaultViewMode}
            options={[
              { value: 'list', label: t('settings.sftp.defaultViewMode.list') },
              { value: 'tree', label: t('settings.sftp.defaultViewMode.tree') },
            ]}
            onChange={(value) => setSftpDefaultViewMode(value as 'list' | 'tree')}
            className="w-48"
          />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.showHiddenFiles')} />
      <SettingCard>
        <SettingRow
          label={t('settings.sftp.showHiddenFiles.enable')}
          description={t('settings.sftp.showHiddenFiles.enableDesc')}
        >
          <Toggle checked={sftpShowHiddenFiles} onChange={setSftpShowHiddenFiles} />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.autoSync')} />
      <SettingCard>
        <SettingRow
          label={t('settings.sftp.autoSync.enable')}
          description={t('settings.sftp.autoSync.enableDesc')}
        >
          <Toggle checked={sftpAutoSync} onChange={setSftpAutoSync} />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.compressedUpload')} />
      <SettingCard>
        <SettingRow
          label={t('settings.sftp.compressedUpload.enable')}
          description={t('settings.sftp.compressedUpload.enableDesc')}
        >
          <Toggle checked={sftpUseCompressedUpload} onChange={setSftpUseCompressedUpload} />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.followTerminalCwd')} />
      <SettingCard>
        <SettingRow
          label={t('settings.sftp.followTerminalCwd.enable')}
          description={t('settings.sftp.followTerminalCwd.enableDesc')}
        >
          <Toggle checked={sftpFollowTerminalCwd} onChange={setSftpFollowTerminalCwd} />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.autoOpenSidebar')} />
      <SettingCard>
        <SettingRow
          label={t('settings.sftp.autoOpenSidebar.enable')}
          description={t('settings.sftp.autoOpenSidebar.enableDesc')}
        >
          <Toggle checked={sftpAutoOpenSidebar} onChange={setSftpAutoOpenSidebar} />
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.transferConcurrency')} />
      <SettingCard>
        <SettingRow description={t('settings.sftp.transferConcurrency.desc')}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={16}
              step={1}
              value={sftpTransferConcurrency}
              onChange={(e) => setSftpTransferConcurrency(Number(e.target.value))}
              className="w-40 accent-primary"
            />
            <span className="text-sm text-muted-foreground w-6 text-center tabular-nums">
              {sftpTransferConcurrency}
            </span>
          </div>
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftp.defaultOpener')} />
      <SettingCard>
        <SettingRow description={t('settings.sftp.defaultOpener.desc')}>
          <div className="flex flex-col items-end gap-2">
            <Select
              value={defaultOpenerValue}
              options={[
                { value: 'ask', label: t('settings.sftp.defaultOpener.ask') },
                { value: 'builtin-editor', label: t('sftp.opener.builtInEditor') },
                {
                  value: 'system-app',
                  label:
                    defaultOpener?.openerType === 'system-app' && defaultOpener.systemApp
                      ? defaultOpener.systemApp.name
                      : t('settings.sftp.defaultOpener.systemApp'),
                },
              ]}
              onChange={handleDefaultOpenerChange}
              className="w-56"
              disabled={isSelectingDefaultApp}
            />
            {defaultOpener?.openerType === 'system-app' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSelectDefaultSystemApp()}
                disabled={isSelectingDefaultApp}
              >
                {t('settings.sftp.defaultOpener.systemApp')}
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingCard>

      <SectionHeader title={t('settings.sftpFileAssociations.title')} />
      <p className="text-xs text-muted-foreground -mt-3 mb-1">
        {t('settings.sftpFileAssociations.desc')}
      </p>

      {associations.length === 0 ? (
        <SettingCard className="py-12">
          <div className="flex flex-col items-center justify-center text-muted-foreground">
            <FileType size={48} strokeWidth={1} className="mb-4 opacity-50" />
            <p className="text-sm">{t('settings.sftpFileAssociations.noAssociations')}</p>
          </div>
        </SettingCard>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-4 py-2 font-medium">
                  {t('settings.sftpFileAssociations.extension')}
                </th>
                <th className="text-left px-4 py-2 font-medium">
                  {t('settings.sftpFileAssociations.application')}
                </th>
                <th className="text-right px-4 py-2 font-medium w-28">
                  {/* Actions */}
                </th>
              </tr>
            </thead>
            <tbody>
              {associations.map(({ extension, openerType, systemApp }) => (
                <tr key={extension} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {extension === 'file' ? t('sftp.opener.noExtension') : `.${extension}`}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {openerType === 'system-app' && systemApp ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-default">{systemApp.name}</span>
                        </TooltipTrigger>
                        <TooltipContent>{systemApp.path}</TooltipContent>
                      </Tooltip>
                    ) : (
                      getOpenerLabel(openerType, systemApp, t)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right space-x-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleEdit(extension)}
                          disabled={editingExtension === extension}
                        >
                          <Pencil size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.edit')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleRemove(extension)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('settings.sftpFileAssociations.remove')}</TooltipContent>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsTabContent>
  );
}
