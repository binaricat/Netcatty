import React from 'react';
import {
    AsidePanel,
    AsidePanelContent,
    type AsidePanelLayout,
} from './ui/aside-panel';
import { ScrollArea } from './ui/scroll-area';
import { ThemeList } from './ThemeList';

interface ThemeSelectPanelProps {
    open: boolean;
    selectedThemeId?: string;
    onSelect: (themeId: string) => void;
    onClose: () => void;
    onBack?: () => void;
    showBackButton?: boolean;
    layout?: AsidePanelLayout;
}

const ThemeSelectPanel: React.FC<ThemeSelectPanelProps> = ({
    open,
    selectedThemeId,
    onSelect,
    onClose,
    onBack,
    showBackButton = true,
    layout = 'overlay',
}) => {
    return (
        <AsidePanel
            open={open}
            onClose={onClose}
            title="Select Color Theme"
            showBackButton={showBackButton}
            onBack={onBack}
            layout={layout}
        >
            <AsidePanelContent className="p-0">
                <ScrollArea className="h-full">
                    <div className="py-2">
                        <ThemeList
                            selectedThemeId={selectedThemeId || ''}
                            onSelect={onSelect}
                        />
                    </div>
                </ScrollArea>
            </AsidePanelContent>
        </AsidePanel>
    );
};

export default ThemeSelectPanel;
