/**
 * Create Group Sub-Panel
 * Panel for creating new groups within the host details
 */
import { FolderPlus,HelpCircle,Plus } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { AsidePanel,AsidePanelContent,type AsidePanelLayout } from '../ui/aside-panel';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

interface ToggleRowProps {
    label: string;
    enabled: boolean;
    onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, enabled, onToggle }) => (
    <div className="flex items-center justify-between">
        <span className="text-sm">{label}</span>
        <button
            type="button"
            onClick={onToggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-muted'
                }`}
        >
            <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'
                    }`}
            />
        </button>
    </div>
);

export interface CreateGroupPanelProps {
    newGroupName: string;
    setNewGroupName: (name: string) => void;
    newGroupParent: string;
    setNewGroupParent: (parent: string) => void;
    groups: string[];
    onSave: () => void;
    onBack: () => void;
    onCancel: () => void;
    layout?: AsidePanelLayout;
}

export const CreateGroupPanel: React.FC<CreateGroupPanelProps> = ({
    newGroupName,
    setNewGroupName,
    newGroupParent,
    setNewGroupParent,
    groups,
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
            title={t('hostDetails.group.title')}
            showBackButton={true}
            onBack={onBack}
            layout={layout}
            actions={
                <Button size="sm" onClick={onSave} disabled={!newGroupName.trim()}>
                    {t('common.save')}
                </Button>
            }
        >
            <AsidePanelContent>
                <Card className="p-3 space-y-3 bg-card border-border/80">
                    <p className="text-xs font-semibold">{t('hostDetails.group.general')}</p>
                    <div className="flex items-center gap-2">
                        <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center">
                            <FolderPlus size={18} className="text-primary" />
                        </div>
                        <Input
                            placeholder={t('hostDetails.group.namePlaceholder')}
                            value={newGroupName}
                            onChange={(e) => setNewGroupName(e.target.value)}
                            className="h-10 flex-1"
                            autoFocus
                        />
                    </div>
                    <div className="relative">
                        <Input
                            placeholder={t('hostDetails.group.parentPlaceholder')}
                            value={newGroupParent}
                            onChange={(e) => setNewGroupParent(e.target.value)}
                            list="parent-group-options"
                            className="h-10"
                        />
                        <datalist id="parent-group-options">
                            {groups.map((g) => <option key={g} value={g} />)}
                        </datalist>
                    </div>
                </Card>

                <Card className="p-3 space-y-2 bg-card border-border/80">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold">{t('hostDetails.group.cloudSync')}</p>
                        <HelpCircle size={14} className="text-muted-foreground" />
                    </div>
                    <ToggleRow label={t('hostDetails.group.cloudSync')} enabled={false} onToggle={() => { }} />
                </Card>

                <Button variant="ghost" className="w-full h-10 gap-2">
                    <Plus size={16} /> {t('hostDetails.group.addProtocol')}
                </Button>
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default CreateGroupPanel;
