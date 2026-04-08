/**
 * Environment Variables Sub-Panel
 * Panel for configuring environment variables for SSH connections
 */
import { Plus,X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { EnvVar } from '../../types';
import { AsidePanel,AsidePanelContent,type AsidePanelLayout } from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

export interface EnvVarsPanelProps {
    hostLabel: string;
    hostHostname: string;
    environmentVariables: EnvVar[];
    newEnvName: string;
    newEnvValue: string;
    setNewEnvName: (name: string) => void;
    setNewEnvValue: (value: string) => void;
    onAddEnvVar: () => void;
    onRemoveEnvVar: (index: number) => void;
    onUpdateEnvVar: (index: number, field: 'name' | 'value', value: string) => void;
    onSave: () => void;
    onBack: () => void;
    onCancel: () => void;
    layout?: AsidePanelLayout;
}

export const EnvVarsPanel: React.FC<EnvVarsPanelProps> = ({
    hostLabel,
    hostHostname,
    environmentVariables,
    newEnvName,
    newEnvValue,
    setNewEnvName,
    setNewEnvValue,
    onAddEnvVar,
    onRemoveEnvVar,
    onUpdateEnvVar,
    onSave,
    onBack,
    onCancel,
    layout = 'overlay',
}) => {
    const { t } = useI18n();
    return (
        <AsidePanel
            open={true}
            onClose={onCancel}
            title={t('hostDetails.envVars.title')}
            showBackButton={true}
            onBack={onBack}
            layout={layout}
            actions={
                <Button size="sm" onClick={onSave}>
                    {t('common.save')}
                </Button>
            }
        >
            <AsidePanelContent>
                <div className="text-sm text-muted-foreground">
                    {t('hostDetails.envVars.desc', { host: hostLabel || hostHostname })}
                    <p className="text-xs mt-1">{t('hostDetails.envVars.note')}</p>
                </div>

                <Button className="w-full h-10" onClick={onAddEnvVar} disabled={!newEnvName.trim()}>
                    <Plus size={14} className="mr-2" /> {t('hostDetails.envVars.add')}
                </Button>

                {/* Existing variables */}
                {environmentVariables.map((envVar, index) => (
                    <Card key={index} className="p-3 space-y-2 bg-card border-border/80">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold">{t('hostDetails.envVars.variable')}</span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                onClick={() => onRemoveEnvVar(index)}
                            >
                                <X size={14} />
                            </Button>
                        </div>
                        <Input
                            placeholder={t('hostDetails.envVars.variable')}
                            value={envVar.name}
                            onChange={(e) => onUpdateEnvVar(index, 'name', e.target.value)}
                            className="h-10"
                        />
                        <Input
                            placeholder={t('hostDetails.envVars.value')}
                            value={envVar.value}
                            onChange={(e) => onUpdateEnvVar(index, 'value', e.target.value)}
                            className="h-10"
                        />
                    </Card>
                ))}

                {/* New variable input */}
                <Card className="p-3 space-y-2 bg-card border-border/80">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold">{t('hostDetails.envVars.newVariable')}</span>
                        <X size={14} className="text-muted-foreground opacity-0" />
                    </div>
                    <Input
                        placeholder={t('hostDetails.envVars.variableName')}
                        value={newEnvName}
                        onChange={(e) => setNewEnvName(e.target.value)}
                        className="h-10"
                    />
                    <Input
                        placeholder={t('hostDetails.envVars.value')}
                        value={newEnvValue}
                        onChange={(e) => setNewEnvValue(e.target.value)}
                        className="h-10"
                    />
                </Card>
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default EnvVarsPanel;
