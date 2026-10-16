/**
 * Port Mapping Rows
 * Repeatable local→destination port pair editor shared by the new-rule and
 * edit panels (pattern follows the jump-host chain rows).
 */
import { ArrowRight, Plus, X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import type { PortForwardingFormRow } from './utils';

export interface MappingRowsProps {
    rows: PortForwardingFormRow[];
    onChange: (rows: PortForwardingFormRow[]) => void;
}

export const MappingRows: React.FC<MappingRowsProps> = ({ rows, onChange }) => {
    const { t } = useI18n();

    const updateRow = (index: number, updates: Partial<PortForwardingFormRow>) => {
        onChange(rows.map((row, i) => (i === index ? { ...row, ...updates } : row)));
    };

    const removeRow = (index: number) => {
        onChange(rows.filter((_, i) => i !== index));
    };

    const localPlaceholder = t('pf.wizard.placeholders.portExample', { port: 8080 });
    const remotePlaceholder = t('pf.wizard.placeholders.portExample', { port: 3306 });

    return (
        <div className="space-y-2">
            <Label className="text-[10px] text-muted-foreground">
                {t('pf.form.mappings')}
            </Label>
            <div className="space-y-2">
                {rows.map((row, index) => (
                    <div
                        key={index}
                        className="flex items-center gap-2 p-2 rounded-lg border border-border/60 bg-card"
                    >
                        <Input
                            type="number"
                            aria-label={t('pf.form.mapping.localPort')}
                            placeholder={localPlaceholder}
                            className="h-9 flex-1 min-w-0"
                            value={row.localPort ?? ''}
                            onChange={(e) => updateRow(index, {
                                localPort: e.target.value === '' ? undefined : parseInt(e.target.value, 10),
                            })}
                        />
                        <ArrowRight size={14} className="text-muted-foreground flex-shrink-0" />
                        <Input
                            type="number"
                            aria-label={t('pf.form.mapping.remotePort')}
                            placeholder={remotePlaceholder}
                            className="h-9 flex-1 min-w-0"
                            value={row.remotePort ?? ''}
                            onChange={(e) => updateRow(index, {
                                remotePort: e.target.value === '' ? undefined : parseInt(e.target.value, 10),
                            })}
                        />
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('pf.form.mapping.remove')}
                            className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={rows.length <= 1}
                            onClick={() => removeRow(index)}
                        >
                            <X size={14} />
                        </Button>
                    </div>
                ))}
            </div>
            <Button
                variant="ghost"
                size="sm"
                className="w-full h-9 border border-dashed border-border/60 text-muted-foreground hover:text-foreground"
                onClick={() => onChange([...rows, { localPort: undefined, remotePort: undefined }])}
            >
                <Plus size={14} className="mr-1" />
                {t('pf.form.addMapping')}
            </Button>
        </div>
    );
};

export default MappingRows;
