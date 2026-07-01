import React from 'react';
import {
    AsidePanel,
    AsidePanelContent,
    type AsidePanelLayout,
    type AsidePanelResizeProps,
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

type ThemeSelectPanelPropsWithResize = ThemeSelectPanelProps & AsidePanelResizeProps;

const ThemeSelectPanel: React.FC<ThemeSelectPanelPropsWithResize> = ({
    open,
    selectedThemeId,
    onSelect,
    onClose,
    onBack,
    showBackButton = true,
    layout = 'overlay',
    resizable,
    persistWidthStorageKey,
    resizeAriaLabel,
}) => {
    return (
        <AsidePanel
            open={open}
            onClose={onClose}
            title="Select Color Theme"
            showBackButton={showBackButton}
            onBack={onBack}
            layout={layout}
            resizable={resizable}
            persistWidthStorageKey={persistWidthStorageKey}
            resizeAriaLabel={resizeAriaLabel}
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
