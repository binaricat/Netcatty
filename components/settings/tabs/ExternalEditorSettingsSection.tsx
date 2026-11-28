/**
 * ExternalEditorSettingsSection - Configure remote SSH external editors (Zed, VS Code, Cursor, etc.),
 * the *.netcatty OpenSSH channel bridge, terminal OSC 7337 permissions, per-host trust, and shell snippets.
 */
import { CheckCircle2, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import {
  useExternalEditorEnvironment,
  useExternalEditorSettings,
} from '../../../application/state/useExternalEditorSettings';
import {
  EXTERNAL_EDITOR_PRESET_IDS,
  EXTERNAL_EDITOR_PRESETS,
  type ExternalEditorConnectionMode,
  type ExternalEditorHostTrustPolicy,
  type ExternalEditorPresetId,
} from '../../../domain/externalEditor';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import {
  SectionHeader,
  Select,
  SettingCard,
  SettingRow,
  SettingsAnchor,
  Toggle,
} from '../settings-ui';

export function ExternalEditorSettingsSection() {
  const { t } = useI18n();
  const {
    settings,
    setDefaultEditor,
    setEditorExecutablePath,
    setCustomEditorArgs,
    setTerminalRequestsEnabled,
    setAutoSetupShellIntegration,
    setDefaultTrustPolicy,
    setConnectionMode,
    setHostTrustPolicy,
    removeHostTrustPolicy,
  } = useExternalEditorSettings();
  const {
    detectedEditors,
    detecting,
    selectingApp,
    bridgeStatus,
    bridgeBusy,
    bridgeError,
    refreshStatus,
    browseExecutable,
    installBridgeConfig,
    removeBridgeConfig,
  } = useExternalEditorEnvironment();

  const selectedEditor = settings.defaultEditor;
  const selectedConfig = settings.editors[selectedEditor];
  const detectedForSelected = detectedEditors[selectedEditor];

  const [executablePathDraft, setExecutablePathDraft] = useState(selectedConfig.executablePath);
  const [isEditingExecutablePath, setIsEditingExecutablePath] = useState(false);

  useEffect(() => {
    setIsEditingExecutablePath(false);
    setExecutablePathDraft(selectedConfig.executablePath);
  }, [selectedEditor]);

  useEffect(() => {
    if (!isEditingExecutablePath) {
      setExecutablePathDraft(selectedConfig.executablePath);
    }
  }, [isEditingExecutablePath, selectedConfig.executablePath]);

  const commitExecutablePathDraft = useCallback(
    (editorId: ExternalEditorPresetId, rawValue: string) => {
      const normalized = rawValue.trim();
      setEditorExecutablePath(editorId, normalized);
      setExecutablePathDraft(normalized);
    },
    [setEditorExecutablePath],
  );

  const storedCustomArgsText = useMemo(
    () => (settings.editors.custom.customArgs || ['{sshUri}']).join(' '),
    [settings.editors.custom.customArgs],
  );
  const [customArgsDraft, setCustomArgsDraft] = useState(storedCustomArgsText);
  const [isEditingCustomArgs, setIsEditingCustomArgs] = useState(false);

  useEffect(() => {
    if (!isEditingCustomArgs) {
      setCustomArgsDraft(storedCustomArgsText);
    }
  }, [isEditingCustomArgs, storedCustomArgsText]);

  const commitCustomArgsDraft = useCallback((rawValue: string) => {
    const tokens = rawValue.trim().split(/\s+/).filter(Boolean);
    const nextTokens = tokens.length > 0 ? tokens : ['{sshUri}'];
    setCustomEditorArgs(nextTokens);
    setCustomArgsDraft(nextTokens.join(' '));
  }, [setCustomEditorArgs]);

  const handleBrowseExecutable = useCallback(async () => {
    const pickedPath = await browseExecutable(selectedEditor);
    if (pickedPath) {
      setExecutablePathDraft(pickedPath);
    }
  }, [browseExecutable, selectedEditor]);

  const trustedHostEntries = useMemo(
    () => Object.entries(settings.trustedHosts).sort(([a], [b]) => a.localeCompare(b)),
    [settings.trustedHosts],
  );

  const effectiveExecutable = selectedConfig.executablePath || detectedForSelected?.detectedPath || '';

  return (
    <>
      <SectionHeader
        title={t('settings.externalEditor.title')}
        anchorId="external-editor-settings"
      />
      <p className="text-xs text-muted-foreground -mt-3 mb-1">
        {t('settings.externalEditor.desc')}
      </p>

      <SettingCard>
        <SettingRow
          anchorId="external-editor-default"
          label={t('settings.externalEditor.preferredEditor')}
          description={t('settings.externalEditor.preferredEditor.desc')}
        >
          <Select
            value={selectedEditor}
            options={EXTERNAL_EDITOR_PRESET_IDS.map((id) => ({
              value: id,
              label: EXTERNAL_EDITOR_PRESETS[id].label,
            }))}
            onChange={(value) => setDefaultEditor(value as ExternalEditorPresetId)}
            className="w-48"
          />
        </SettingRow>

        <SettingsAnchor anchorId="external-editor-executable" className="py-3 space-y-2 border-t border-border/60">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">{t('settings.externalEditor.executablePath')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('settings.externalEditor.executablePath.desc')}
              </div>
            </div>
            {selectedEditor !== 'custom' && (
              <span
                className={
                  effectiveExecutable
                    ? 'inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400'
                    : 'text-xs text-muted-foreground'
                }
              >
                {effectiveExecutable ? (
                  <>
                    <CheckCircle2 size={13} />
                    {selectedConfig.executablePath
                      ? t('settings.externalEditor.status.configured')
                      : t('settings.externalEditor.status.detected')}
                  </>
                ) : (
                  t('settings.externalEditor.status.notFound')
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={executablePathDraft}
              onFocus={() => setIsEditingExecutablePath(true)}
              onChange={(e) => setExecutablePathDraft(e.target.value)}
              onBlur={(e) => {
                setIsEditingExecutablePath(false);
                commitExecutablePathDraft(selectedEditor, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitExecutablePathDraft(selectedEditor, e.currentTarget.value);
                  e.currentTarget.blur();
                }
              }}
              placeholder={
                detectedForSelected?.detectedPath
                  || t('settings.externalEditor.executablePath.placeholder')
              }
              className="font-mono text-xs h-8 flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleBrowseExecutable()}
              disabled={selectingApp}
              className="shrink-0"
            >
              {t('settings.externalEditor.browse')}
            </Button>
            {(selectedConfig.executablePath || executablePathDraft) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      setIsEditingExecutablePath(false);
                      setExecutablePathDraft('');
                      setEditorExecutablePath(selectedEditor, '');
                    }}
                    aria-label={t('settings.externalEditor.resetPath')}
                  >
                    <RotateCcw size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('settings.externalEditor.resetPath')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => void refreshStatus()}
                  disabled={detecting}
                  aria-label={t('settings.externalEditor.redetect')}
                >
                  <RefreshCw size={14} className={detecting ? 'animate-spin' : undefined} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('settings.externalEditor.redetect')}</TooltipContent>
            </Tooltip>
          </div>
        </SettingsAnchor>

        {selectedEditor === 'custom' && (
          <SettingsAnchor anchorId="external-editor-custom-args" className="py-3 space-y-2 border-t border-border/60">
            <div>
              <div className="text-sm font-medium">{t('settings.externalEditor.customArgs')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('settings.externalEditor.customArgs.desc')}
              </div>
            </div>
            <Input
              value={customArgsDraft}
              onFocus={() => setIsEditingCustomArgs(true)}
              onChange={(e) => setCustomArgsDraft(e.target.value)}
              onBlur={(e) => {
                setIsEditingCustomArgs(false);
                commitCustomArgsDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitCustomArgsDraft(e.currentTarget.value);
                  e.currentTarget.blur();
                }
              }}
              placeholder="{sshUri}"
              className="font-mono text-xs h-8"
            />
          </SettingsAnchor>
        )}

        <SettingRow
          anchorId="external-editor-connection-mode"
          label={t('settings.externalEditor.connectionMode')}
          description={t('settings.externalEditor.connectionMode.desc')}
        >
          <Select
            value={settings.connectionMode}
            options={[
              { value: 'bridge', label: t('settings.externalEditor.connectionMode.bridge') },
              { value: 'direct', label: t('settings.externalEditor.connectionMode.direct') },
            ]}
            onChange={(value) => setConnectionMode(value as ExternalEditorConnectionMode)}
            className="w-56"
          />
        </SettingRow>

        {settings.connectionMode === 'bridge' && (
          <SettingsAnchor anchorId="external-editor-ssh-bridge" className="py-3 space-y-2 border-t border-border/60">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-primary shrink-0" />
                  {t('settings.externalEditor.sshBridge.title')}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t('settings.externalEditor.sshBridge.desc')}
                </div>
                {bridgeStatus?.sshConfigPath && (
                  <div className="text-[11px] font-mono text-muted-foreground mt-1 truncate">
                    {bridgeStatus.sshConfigPath}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {bridgeStatus?.installed ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void installBridgeConfig()}
                      disabled={bridgeBusy}
                    >
                      {bridgeStatus.upToDate
                        ? t('settings.externalEditor.sshBridge.reinstall')
                        : t('settings.externalEditor.sshBridge.update')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => void removeBridgeConfig()}
                      disabled={bridgeBusy}
                    >
                      {t('settings.externalEditor.sshBridge.remove')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void installBridgeConfig()}
                    disabled={bridgeBusy}
                  >
                    {t('settings.externalEditor.sshBridge.install')}
                  </Button>
                )}
              </div>
            </div>
            {bridgeError && (
              <p className="text-xs text-destructive">{bridgeError}</p>
            )}
          </SettingsAnchor>
        )}

        <SettingRow
          anchorId="external-editor-terminal-requests"
          label={t('settings.externalEditor.terminalRequests')}
          description={t('settings.externalEditor.terminalRequests.desc')}
        >
          <Toggle
            checked={settings.terminalRequestsEnabled}
            onChange={setTerminalRequestsEnabled}
          />
        </SettingRow>

        <SettingRow
          anchorId="external-editor-auto-setup"
          label={t('settings.externalEditor.autoSetup')}
          description={t('settings.externalEditor.autoSetup.desc')}
        >
          <Toggle
            checked={settings.autoSetupShellIntegration}
            onChange={setAutoSetupShellIntegration}
            disabled={!settings.terminalRequestsEnabled}
          />
        </SettingRow>

        <SettingRow
          anchorId="external-editor-default-trust"
          label={t('settings.externalEditor.defaultTrust')}
          description={t('settings.externalEditor.defaultTrust.desc')}
        >
          <Select
            value={settings.defaultTrustPolicy}
            options={[
              { value: 'ask', label: t('settings.externalEditor.trust.ask') },
              { value: 'allow', label: t('settings.externalEditor.trust.allow') },
              { value: 'deny', label: t('settings.externalEditor.trust.deny') },
            ]}
            onChange={(value) => setDefaultTrustPolicy(value as ExternalEditorHostTrustPolicy)}
            className="w-48"
            disabled={!settings.terminalRequestsEnabled}
          />
        </SettingRow>
      </SettingCard>

      {trustedHostEntries.length > 0 && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left px-4 py-2 font-medium">
                  {t('settings.externalEditor.trustedHosts.host')}
                </th>
                <th className="text-left px-4 py-2 font-medium">
                  {t('settings.externalEditor.trustedHosts.policy')}
                </th>
                <th className="text-right px-4 py-2 font-medium w-16" />
              </tr>
            </thead>
            <tbody>
              {trustedHostEntries.map(([hostKey, policy]) => (
                <tr key={hostKey} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">{hostKey}</td>
                  <td className="px-4 py-2">
                    <Select
                      value={policy}
                      options={[
                        { value: 'allow', label: t('settings.externalEditor.trust.allow') },
                        { value: 'ask', label: t('settings.externalEditor.trust.ask') },
                        { value: 'deny', label: t('settings.externalEditor.trust.deny') },
                      ]}
                      onChange={(value) => setHostTrustPolicy(hostKey, value as ExternalEditorHostTrustPolicy)}
                      className="w-40"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removeHostTrustPolicy(hostKey)}
                      aria-label={t('action.remove')}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
