import React, { useMemo, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ROOT_PACKAGE_VALUE = '__root__';

function toSelectValue(packagePath: string): string {
  return packagePath || ROOT_PACKAGE_VALUE;
}

function fromSelectValue(value: string): string {
  return value === ROOT_PACKAGE_VALUE ? '' : value;
}

export interface ScriptSaveRecordingDialogProps {
  open: boolean;
  code: string;
  packages: string[];
  defaultName?: string;
  onClose: () => void;
  onSave: (payload: { name: string; packagePath: string; code: string; editAfterSave: boolean }) => void;
}

export const ScriptSaveRecordingDialog: React.FC<ScriptSaveRecordingDialogProps> = ({
  open,
  code,
  packages,
  defaultName,
  onClose,
  onSave,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState(defaultName || '');
  const [packageSelectValue, setPackageSelectValue] = useState(ROOT_PACKAGE_VALUE);

  const packageOptions = useMemo(() => {
    const unique = Array.from(new Set(packages.filter(Boolean)));
    return [ROOT_PACKAGE_VALUE, ...unique];
  }, [packages]);

  React.useEffect(() => {
    if (!open) return;
    setName(defaultName || '');
    setPackageSelectValue(toSelectValue(packages[0] || ''));
  }, [defaultName, open, packages]);

  const handleSave = (editAfterSave: boolean) => {
    onSave({
      name,
      packagePath: fromSelectValue(packageSelectValue),
      code,
      editAfterSave,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('scripts.recording.saveTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('scripts.recording.namePlaceholder')}
          />
          <Select value={packageSelectValue} onValueChange={setPackageSelectValue}>
            <SelectTrigger><SelectValue placeholder={t('scripts.recording.packagePlaceholder')} /></SelectTrigger>
            <SelectContent>
              {packageOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === ROOT_PACKAGE_VALUE ? t('scripts.recording.rootPackage') : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <pre className="text-xs bg-secondary/40 rounded p-3 max-h-48 overflow-auto whitespace-pre-wrap">{code}</pre>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="outline" onClick={() => handleSave(false)}>
            {t('scripts.recording.save')}
          </Button>
          <Button onClick={() => handleSave(true)}>
            {t('scripts.recording.saveAndEdit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
