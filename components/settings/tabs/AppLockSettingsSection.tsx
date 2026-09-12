import React, { useCallback, useState } from 'react';

import { useI18n } from '../../../application/i18n/I18nProvider';
import type { AppLockSystemUnlockStatus } from '../../../application/state/useAppLockState';
import {
  APP_LOCK_TIMEOUT_OPTIONS_MINUTES,
  type AppLockSettings,
  type AppLockSettingsChangeError,
  type AppLockTimeoutMinutes,
} from '../../../domain/appLock';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Select, SettingCard, SettingHint, SettingRow, SectionHeader, Toggle } from '../settings-ui';

type AppLockDialogMode = 'setup' | 'change' | 'disable' | null;

interface AppLockSettingsSectionProps {
  appLockSettings: AppLockSettings;
  setAppLockTimeoutMinutes: (timeoutMinutes: AppLockTimeoutMinutes) => void;
  requestAppLockDisable: (
    currentPassword: string,
  ) => Promise<AppLockSettings | { ok: false; error: AppLockSettingsChangeError }>;
  requestAppLockPasswordChange: (input: {
    currentPassword?: string;
    nextPassword: string;
  }) => Promise<AppLockSettings | { ok: false; error: AppLockSettingsChangeError }>;
  appLockSystemUnlockStatus?: AppLockSystemUnlockStatus;
  setAppLockSystemUnlockEnabled?: (input: {
    enabled: boolean;
    currentPassword?: string;
    autoPromptEnabled?: boolean;
  }) => Promise<
    AppLockSettings
    | { ok: false; error: 'empty-current' | 'incorrect' | 'locked' | 'unsupported' | 'unavailable' | 'cancelled' | 'failed' }
  >;
}

export const AppLockSettingsSection: React.FC<AppLockSettingsSectionProps> = ({
  appLockSettings,
  setAppLockTimeoutMinutes,
  requestAppLockDisable,
  requestAppLockPasswordChange,
  appLockSystemUnlockStatus,
  setAppLockSystemUnlockEnabled,
}) => {
  const { t } = useI18n();
  const [dialogMode, setDialogMode] = useState<AppLockDialogMode>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [isSavingSystemUnlock, setIsSavingSystemUnlock] = useState(false);

  const hasPassword = Boolean(appLockSettings.passwordVerifier);
  const isDialogBusy = isDisabling || isSavingPassword;
  const showSystemUnlock = Boolean(
    hasPassword
    && appLockSystemUnlockStatus?.supported
    && appLockSystemUnlockStatus.label
    && (appLockSystemUnlockStatus.available || appLockSettings.systemUnlockEnabled),
  );
  const timeoutOptions = APP_LOCK_TIMEOUT_OPTIONS_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: t(`settings.appLock.timeout.${minutes}`),
  }));

  const mapChangeError = useCallback((
    changeError: AppLockSettingsChangeError | 'locked' | 'unsupported' | 'unavailable' | 'failed',
  ): string => {
    switch (changeError) {
      case 'empty-current':
        return t('settings.appLock.validation.currentRequired');
      case 'empty-next':
        return t('settings.appLock.validation.newRequired');
      case 'incorrect':
        return t('settings.appLock.validation.incorrect');
      case 'locked':
        return t('settings.appLock.systemUnlock.locked');
      case 'unsupported':
      case 'unavailable':
      case 'failed':
        return t('settings.appLock.systemUnlock.unavailable');
    }
  }, [t]);

  const resetDialog = useCallback(() => {
    setDialogMode(null);
    setCurrentPassword('');
    setDisablePassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  }, []);

  const openDialog = useCallback((mode: Exclude<AppLockDialogMode, null>) => {
    setError(null);
    setDialogMode(mode);
  }, []);

  const handleTimeoutChange = useCallback((value: string) => {
    const timeoutMinutes = Number(value) as AppLockTimeoutMinutes;
    if (!APP_LOCK_TIMEOUT_OPTIONS_MINUTES.includes(timeoutMinutes)) return;
    setAppLockTimeoutMinutes(timeoutMinutes);
  }, [setAppLockTimeoutMinutes]);

  const handleDisable = useCallback(async () => {
    setError(null);
    setIsDisabling(true);
    try {
      const result = await requestAppLockDisable(disablePassword);
      if ('ok' in result && result.ok === false) {
        setError(mapChangeError(result.error));
        return;
      }
      resetDialog();
    } finally {
      setIsDisabling(false);
    }
  }, [disablePassword, mapChangeError, requestAppLockDisable, resetDialog]);

  const handleSavePassword = useCallback(async () => {
    setError(null);
    if (newPassword.length === 0) {
      setError(t('settings.appLock.validation.newRequired'));
      return;
    }
    if (confirmPassword.length === 0) {
      setError(t('settings.appLock.validation.confirmRequired'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.appLock.validation.mismatch'));
      return;
    }

    setIsSavingPassword(true);
    try {
      const result = await requestAppLockPasswordChange({
        currentPassword: hasPassword ? currentPassword : undefined,
        nextPassword: newPassword,
      });
      if ('ok' in result && result.ok === false) {
        setError(mapChangeError(result.error));
        return;
      }
      resetDialog();
    } finally {
      setIsSavingPassword(false);
    }
  }, [
    confirmPassword,
    currentPassword,
    hasPassword,
    mapChangeError,
    newPassword,
    requestAppLockPasswordChange,
    resetDialog,
    t,
  ]);

  const handleSystemUnlockChange = useCallback(async (enabled: boolean) => {
    if (!setAppLockSystemUnlockEnabled || !appLockSystemUnlockStatus?.label) return;
    setError(null);
    setIsSavingSystemUnlock(true);
    try {
      const result = await setAppLockSystemUnlockEnabled({
        enabled,
        autoPromptEnabled: enabled && appLockSettings.systemUnlockEnabled
          ? appLockSettings.systemUnlockAutoPromptEnabled
          : false,
      });
      if ('ok' in result && result.ok === false) {
        if (result.error === 'cancelled') return;
        setError(mapChangeError(result.error));
      }
    } finally {
      setIsSavingSystemUnlock(false);
    }
  }, [
    appLockSettings.systemUnlockAutoPromptEnabled,
    appLockSettings.systemUnlockEnabled,
    appLockSystemUnlockStatus?.label,
    mapChangeError,
    setAppLockSystemUnlockEnabled,
  ]);

  const handleAutoPromptChange = useCallback(async (autoPromptEnabled: boolean) => {
    if (!setAppLockSystemUnlockEnabled || !appLockSystemUnlockStatus?.label) return;
    if (!appLockSettings.systemUnlockEnabled) return;
    setError(null);
    setIsSavingSystemUnlock(true);
    try {
      const result = await setAppLockSystemUnlockEnabled({ enabled: true, autoPromptEnabled });
      if ('ok' in result && result.ok === false) {
        if (result.error === 'cancelled') return;
        setError(mapChangeError(result.error));
      }
    } finally {
      setIsSavingSystemUnlock(false);
    }
  }, [
    appLockSettings.systemUnlockEnabled,
    appLockSystemUnlockStatus?.label,
    mapChangeError,
    setAppLockSystemUnlockEnabled,
  ]);

  const dialogTitle = dialogMode === 'disable'
    ? t('settings.appLock.disableTitle')
    : dialogMode === 'change'
      ? t('settings.appLock.changePasswordTitle')
      : t('settings.appLock.setupPasswordTitle');
  const dialogDescription = dialogMode === 'disable'
    ? t('settings.appLock.disableDescription')
    : dialogMode === 'change'
      ? t('settings.appLock.changePasswordDescription')
      : t('settings.appLock.setupPasswordDescription');

  return (
    <>
      <SectionHeader title={t('settings.appLock.title')} anchorId="system-app-lock" />
      <SettingCard divided>
        {!hasPassword ? (
          <SettingRow
            label={t('settings.appLock.setupTitle')}
            description={t('settings.appLock.setupDescription')}
          >
            <Button type="button" size="sm" onClick={() => openDialog('setup')}>
              {t('settings.appLock.savePassword')}
            </Button>
          </SettingRow>
        ) : (
          <>
            <SettingRow
              label={t('settings.appLock.manageTitle')}
              description={appLockSettings.enabled
                ? t('settings.appLock.enabledStatus')
                : t('settings.appLock.disabledStatus')}
            >
              <span className={appLockSettings.enabled
                ? 'text-xs font-medium text-emerald-600 dark:text-emerald-400'
                : 'text-xs font-medium text-muted-foreground'}
              >
                {t(appLockSettings.enabled ? 'common.enabled' : 'common.disabled')}
              </span>
            </SettingRow>

            <SettingRow
              label={t('settings.appLock.timeout')}
              description={t('settings.appLock.timeoutDesc')}
            >
              <Select
                value={String(appLockSettings.timeoutMinutes)}
                options={timeoutOptions}
                onChange={handleTimeoutChange}
                className="w-36"
              />
            </SettingRow>

            {showSystemUnlock && appLockSystemUnlockStatus?.label && (
              <>
                <SettingRow
                  label={t('settings.appLock.systemUnlock.label').replace('{label}', appLockSystemUnlockStatus.label)}
                  description={appLockSystemUnlockStatus.available
                    ? t('settings.appLock.systemUnlock.desc').replace('{label}', appLockSystemUnlockStatus.label)
                    : t('settings.appLock.systemUnlock.unavailableDesc').replace('{label}', appLockSystemUnlockStatus.label)}
                >
                  <Toggle
                    checked={appLockSettings.systemUnlockEnabled}
                    disabled={
                      isSavingSystemUnlock
                      || (!appLockSystemUnlockStatus.available && !appLockSettings.systemUnlockEnabled)
                    }
                    ariaLabel={t('settings.appLock.systemUnlock.label').replace('{label}', appLockSystemUnlockStatus.label)}
                    onChange={(enabled) => void handleSystemUnlockChange(enabled)}
                  />
                </SettingRow>
                <SettingRow
                  label={t('settings.appLock.systemUnlock.autoPrompt.label').replace('{label}', appLockSystemUnlockStatus.label)}
                  description={t('settings.appLock.systemUnlock.autoPrompt.desc').replace('{label}', appLockSystemUnlockStatus.label)}
                >
                  <Toggle
                    checked={appLockSettings.systemUnlockAutoPromptEnabled}
                    disabled={
                      isSavingSystemUnlock
                      || !appLockSettings.systemUnlockEnabled
                      || !appLockSystemUnlockStatus.available
                    }
                    ariaLabel={t('settings.appLock.systemUnlock.autoPrompt.label').replace('{label}', appLockSystemUnlockStatus.label)}
                    onChange={(enabled) => void handleAutoPromptChange(enabled)}
                  />
                </SettingRow>
              </>
            )}

            <SettingRow
              label={t('settings.appLock.changePasswordTitle')}
              description={t('settings.appLock.changePasswordDescription')}
            >
              <Button type="button" size="sm" variant="outline" onClick={() => openDialog('change')}>
                {t('settings.appLock.replacePassword')}
              </Button>
            </SettingRow>

            {appLockSettings.enabled && (
              <SettingRow
                label={t('settings.appLock.disableTitle')}
                description={t('settings.appLock.disableDescription')}
              >
                <Button type="button" size="sm" variant="destructive" onClick={() => openDialog('disable')}>
                  {t('settings.appLock.disable')}
                </Button>
              </SettingRow>
            )}
          </>
        )}
      </SettingCard>
      <SettingHint>{t('settings.appLock.localOnlyHint')}</SettingHint>
      {error && dialogMode === null && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}

      <Dialog
        open={dialogMode !== null}
        onOpenChange={(open) => {
          if (!open && !isDialogBusy) resetDialog();
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (dialogMode === 'disable') {
                void handleDisable();
              } else {
                void handleSavePassword();
              }
            }}
          >
            <div className="space-y-3">
              {dialogMode === 'disable' && (
                <div className="space-y-2">
                  <Label htmlFor="app-lock-disable-password">{t('settings.appLock.currentPassword')}</Label>
                  <Input
                    id="app-lock-disable-password"
                    type="password"
                    value={disablePassword}
                    autoComplete="current-password"
                    placeholder={t('settings.appLock.currentPasswordForDisablePlaceholder')}
                    disabled={isDialogBusy}
                    onChange={(event) => {
                      setDisablePassword(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
              )}

              {dialogMode === 'change' && (
                <div className="space-y-2">
                  <Label htmlFor="app-lock-current-password">{t('settings.appLock.currentPassword')}</Label>
                  <Input
                    id="app-lock-current-password"
                    type="password"
                    value={currentPassword}
                    autoComplete="current-password"
                    placeholder={t('settings.appLock.currentPasswordForChangePlaceholder')}
                    disabled={isDialogBusy}
                    onChange={(event) => {
                      setCurrentPassword(event.target.value);
                      setError(null);
                    }}
                  />
                </div>
              )}

              {dialogMode !== 'disable' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="app-lock-new-password">{t('settings.appLock.newPassword')}</Label>
                    <Input
                      id="app-lock-new-password"
                      type="password"
                      value={newPassword}
                      autoComplete="new-password"
                      placeholder={t('settings.appLock.newPasswordPlaceholder')}
                      disabled={isDialogBusy}
                      onChange={(event) => {
                        setNewPassword(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="app-lock-confirm-password">{t('settings.appLock.confirmPassword')}</Label>
                    <Input
                      id="app-lock-confirm-password"
                      type="password"
                      value={confirmPassword}
                      autoComplete="new-password"
                      placeholder={t('settings.appLock.confirmPasswordPlaceholder')}
                      disabled={isDialogBusy}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setError(null);
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={isDialogBusy} onClick={resetDialog}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant={dialogMode === 'disable' ? 'destructive' : 'default'}
                disabled={isDialogBusy}
              >
                {dialogMode === 'disable'
                  ? (isDisabling ? t('settings.appLock.disabling') : t('settings.appLock.disable'))
                  : (isSavingPassword ? t('settings.appLock.savingPassword') : t('settings.appLock.savePassword'))}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
