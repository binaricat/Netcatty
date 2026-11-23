/**
 * Port Forwarding New Form Panel
 * All-in-one form for creating new port forwarding rules (skip wizard mode)
 */
import { Zap } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host, PortForwardingRule, PortForwardingType } from '../../domain/models';
import { cn } from '../../lib/utils';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { PortForwardRuleFields } from './PortForwardRuleFields';
import { getTypeLabel } from './utils';

export interface NewFormPanelProps extends AsidePanelResizeProps {
  draft: Partial<PortForwardingRule>;
  hosts: Host[];
  onDraftChange: (updates: Partial<PortForwardingRule>) => void;
  onSave: () => void;
  onClose: () => void;
  onOpenHostSelector: () => void;
  onOpenWizard: () => void;
  isValid: boolean;
  layout?: AsidePanelLayout;
}

export const NewFormPanel: React.FC<NewFormPanelProps> = ({
  draft,
  hosts,
  onDraftChange,
  onSave,
  onClose,
  onOpenHostSelector,
  onOpenWizard,
  isValid,
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
      title={t('pf.wizard.newTitle')}
      width="w-[360px]"
      layout={layout}
      resizable={resizable}
      persistWidthStorageKey={persistWidthStorageKey}
      resizeAriaLabel={resizeAriaLabel}
    >
      <AsidePanelContent>
        {/* Type Selector */}
        <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
          {(['local', 'remote', 'dynamic'] as PortForwardingType[]).map((type) => (
            <Button
              key={type}
              variant={draft.type === type ? 'default' : 'ghost'}
              size="sm"
              className={cn(
                'flex-1 h-9',
                draft.type === type ? 'bg-primary text-primary-foreground' : ''
              )}
              onClick={() => onDraftChange({ type })}
            >
              {getTypeLabel(t, type)}
            </Button>
          ))}
        </div>

        <PortForwardRuleFields
          diagramType={draft.type || 'local'}
          draft={draft}
          hosts={hosts}
          onDraftChange={onDraftChange}
          onOpenHostSelector={onOpenHostSelector}
        />
      </AsidePanelContent>
      <AsidePanelFooter className="space-y-2">
        <Button className="w-full h-10" disabled={!isValid} onClick={onSave}>
          {t('pf.form.createRule')}
        </Button>
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            className="h-10 text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="text-xs text-muted-foreground hover:text-foreground/80 flex items-center gap-1 px-2 py-1 rounded hover:bg-foreground/5 transition-colors"
                onClick={onOpenWizard}
              >
                <Zap size={12} />
                {t('pf.form.openWizard')}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('pf.form.openWizardTitle')}</TooltipContent>
          </Tooltip>
        </div>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default NewFormPanel;
