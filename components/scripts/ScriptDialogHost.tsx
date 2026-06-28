import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import type { ScriptDialogRequest } from '@/types/global/netcatty-bridge-script.d.ts';

export function ScriptDialogHost() {
  const { t } = useI18n();
  const [request, setRequest] = useState<ScriptDialogRequest | null>(null);
  const [promptValue, setPromptValue] = useState('');

  useEffect(() => {
    const dispose = netcattyBridge.get()?.onScriptDialogRequest?.((payload) => {
      setRequest(payload);
      setPromptValue(payload.defaultValue ?? '');
    });
    return dispose;
  }, []);

  const respond = useCallback(async (value?: unknown, cancelled = false) => {
    if (!request) return;
    await netcattyBridge.get()?.scriptDialogResponse?.(request.requestId, value, cancelled);
    setRequest(null);
  }, [request]);

  if (!request) return null;

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) {
        void respond(request.type === 'waitForTimeout' ? 'abort' : undefined, true);
      }
    }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {request.type === 'waitForTimeout'
              ? t('scripts.dialog.waitForTimeoutTitle')
              : t('scripts.dialog.title')}
          </DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>
        {request.type === 'prompt' ? (
          <Input
            value={promptValue}
            onChange={(event) => setPromptValue(event.target.value)}
            autoFocus
          />
        ) : null}
        <DialogFooter>
          {request.type === 'waitForTimeout' ? (
            <>
              <Button variant="outline" onClick={() => void respond('abort')}>
                {t('scripts.dialog.abort')}
              </Button>
              <Button variant="secondary" onClick={() => void respond('skip')}>
                {t('scripts.dialog.skip')}
              </Button>
              <Button onClick={() => void respond('retry')}>
                {t('scripts.dialog.retry')}
              </Button>
            </>
          ) : request.type === 'confirm' ? (
            <>
              <Button variant="outline" onClick={() => void respond(false)}>{t('common.cancel')}</Button>
              <Button onClick={() => void respond(true)}>{t('scripts.dialog.ok')}</Button>
            </>
          ) : request.type === 'prompt' ? (
            <>
              <Button variant="outline" onClick={() => void respond(undefined, true)}>{t('common.cancel')}</Button>
              <Button onClick={() => void respond(promptValue)}>{t('scripts.dialog.ok')}</Button>
            </>
          ) : (
            <Button onClick={() => void respond(undefined)}>{t('scripts.dialog.ok')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
