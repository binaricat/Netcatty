/**
 * FileOpenerDialog - Dialog for choosing how to open a file
 */
import { Edit2, FolderOpen } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { FileOpenerType, SystemAppInfo } from '../lib/sftpFileUtils';
import { getFileExtension, isKnownBinaryFile } from '../lib/sftpFileUtils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

interface FileOpenerDialogProps {
  open: boolean;
  onClose: () => void;
  fileName: string;
  onSelect: (openerType: FileOpenerType, setAsDefault: boolean, systemApp?: SystemAppInfo) => void;
  onSelectSystemApp: () => Promise<SystemAppInfo | null>;
}

export const FileOpenerDialog: React.FC<FileOpenerDialogProps> = ({
  open,
  onClose,
  fileName,
  onSelect,
  onSelectSystemApp,
}) => {
  const { t } = useI18n();
  const [isSelectingApp, setIsSelectingApp] = useState(false);
  const [rememberChoice, setRememberChoice] = useState(true);

  const extension = getFileExtension(fileName);
  // Show edit option for files that are not known binary formats
  const canEdit = !isKnownBinaryFile(fileName);
  // For files without extension, we use 'file' as virtual extension
  // So we always allow setting default (hasExtension is always true)
  const displayExtension = extension === 'file' ? t('sftp.opener.noExtension') : `.${extension}`;

  const handleSelectBuiltIn = useCallback((openerType: FileOpenerType) => {
    onSelect(openerType, rememberChoice);
    onClose();
  }, [rememberChoice, onSelect, onClose]);

  const handleSelectSystemApp = useCallback(async () => {
    setIsSelectingApp(true);
    try {
      const result = await onSelectSystemApp();
      if (result) {
        onSelect('system-app', rememberChoice, result);
        onClose();
      }
    } catch (e) {
      console.error('Failed to select application:', e);
    } finally {
      setIsSelectingApp(false);
    }
  }, [onSelectSystemApp, rememberChoice, onSelect, onClose]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      // Don't close while selecting system app
      if (!isOpen && !isSelectingApp) {
        onClose();
      }
    }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader className="min-w-0">
          <DialogTitle>{t('sftp.opener.title')}</DialogTitle>
          <DialogDescription className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
            {fileName}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-2">
          {canEdit && (
            <Button
              variant="outline"
              className="w-full justify-start gap-3 h-12"
              onClick={() => handleSelectBuiltIn('builtin-editor')}
            >
              <Edit2 size={18} className="text-primary" />
              <div className="text-left">
                <div className="font-medium text-sm">{t('sftp.opener.builtInEditor')}</div>
                <div className="text-xs text-muted-foreground">{t('sftp.opener.editDescription')}</div>
              </div>
            </Button>
          )}

          {/* System application option */}
          <Button
            variant="outline"
            className="w-full justify-start gap-3 h-12"
            onClick={handleSelectSystemApp}
            disabled={isSelectingApp}
          >
            <FolderOpen size={18} className="text-primary" />
            <div className="text-left">
              <div className="font-medium text-sm">{t('sftp.opener.systemApp')}</div>
              <div className="text-xs text-muted-foreground">{t('sftp.opener.systemAppDescription')}</div>
            </div>
          </Button>

        </div>

        {/* Remember choice checkbox - always show, use 'file' for no extension */}
        <div className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            id="remember-choice"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
            className="rounded border-border h-4 w-4 accent-primary"
          />
          <label
            htmlFor="remember-choice"
            className="text-sm text-muted-foreground cursor-pointer select-none"
          >
            {t('sftp.opener.setDefault', { ext: displayExtension })}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FileOpenerDialog;
