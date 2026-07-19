import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
} from '../ui/context-menu';
import type { ColumnWidths, SftpColumnVisibility } from './utils';

interface SftpColumnMenuItemsProps {
  visibleColumns: SftpColumnVisibility;
  directoriesFirst: boolean;
  toggleColumnVisibility: (field: keyof ColumnWidths) => void;
  toggleDirectoriesFirst: () => void;
}

export const SftpColumnMenuItems: React.FC<SftpColumnMenuItemsProps> = ({
  visibleColumns,
  directoriesFirst,
  toggleColumnVisibility,
  toggleDirectoriesFirst,
}) => {
  const { t } = useI18n();

  return (
    <>
      <ContextMenuCheckboxItem checked disabled>
        {t('sftp.columns.name')}
      </ContextMenuCheckboxItem>
      {(['modified', 'size', 'type'] as const).map((field) => (
        <ContextMenuCheckboxItem
          key={field}
          checked={visibleColumns[field]}
          onCheckedChange={() => toggleColumnVisibility(field)}
        >
          {t(field === 'type' ? 'sftp.columns.kind' : `sftp.columns.${field}`)}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem
        checked={directoriesFirst}
        onCheckedChange={toggleDirectoriesFirst}
      >
        {t('sftp.sort.directoriesFirst')}
      </ContextMenuCheckboxItem>
    </>
  );
};
