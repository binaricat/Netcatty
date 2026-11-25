/**
 * Port Forwarding Edit Panel
 * Form for editing an existing port forwarding rule
 */
import { Copy, Trash2 } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host, PortForwardingRule } from '../../domain/models';
import {
  AsideActionMenu,
  AsideActionMenuItem,
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from '../ui/aside-panel';
import { Button } from '../ui/button';
import { PortForwardRuleFields } from './PortForwardRuleFields';

export interface EditPanelProps extends AsidePanelResizeProps {
  rule: PortForwardingRule;
  draft: Partial<PortForwardingRule>;
  hosts: Host[];
  onDraftChange: (updates: Partial<PortForwardingRule>) => void;
  onSave: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenHostSelector: () => void;
  layout?: AsidePanelLayout;
}

export const EditPanel: React.FC<EditPanelProps> = ({
  rule,
  draft,
  hosts,
  onDraftChange,
  onSave,
  onClose,
  onDuplicate,
  onDelete,
  onOpenHostSelector,
  layout = 'inline',
  resizable = false,
  persistWidthStorageKey,
  resizeAriaLabel,
}) => {
  const { t } = useI18n();

  return (
    <AsidePanel
      open={true}
      onClose={onClose}
      title={t('pf.wizard.editTitle')}
      width="w-[360px]"
      layout={layout}
      resizable={resizable}
      persistWidthStorageKey={persistWidthStorageKey}
      resizeAriaLabel={resizeAriaLabel}
      actions={
        <AsideActionMenu>
          <AsideActionMenuItem
            icon={<Copy size={14} />}
            onClick={onDuplicate}
          >
            {t('action.duplicate')}
          </AsideActionMenuItem>
          <AsideActionMenuItem
            icon={<Trash2 size={14} />}
            variant="destructive"
            onClick={onDelete}
          >
            {t('action.delete')}
          </AsideActionMenuItem>
        </AsideActionMenu>
      }
    >
      <AsidePanelContent>
        <PortForwardRuleFields
          diagramType={draft.type || rule.type}
          draft={draft}
          hosts={hosts}
          onDraftChange={onDraftChange}
          onOpenHostSelector={onOpenHostSelector}
        />
      </AsidePanelContent>
      <AsidePanelFooter className="space-y-2">
        <Button className="w-full h-10" onClick={onSave}>
          {t('common.saveChanges')}
        </Button>
        <Button
          variant="ghost"
          className="w-full h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          onClick={onClose}
        >
          {t('common.cancel')}
        </Button>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default EditPanel;
