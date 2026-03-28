import { ArrowLeft, MoreVertical, X } from 'lucide-react';
import React, { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ScrollArea } from './scroll-area';

// Types
interface AsideContentItem {
    id: string;
    title: string;
    subtitle?: string;
    actions?: ReactNode;
    content: ReactNode;
}

interface AsidePanelContextType {
    push: (item: AsideContentItem) => void;
    pop: () => void;
    replace: (item: AsideContentItem) => void;
    clear: () => void;
    canGoBack: boolean;
    currentItem: AsideContentItem | null;
}

const AsidePanelContext = createContext<AsidePanelContextType | null>(null);

export const useAsidePanel = () => {
    const context = useContext(AsidePanelContext);
    if (!context) {
        throw new Error('useAsidePanel must be used within an AsidePanel');
    }
    return context;
};

// Props
interface AsidePanelProps {
    open: boolean;
    onClose: () => void;
    title?: string;
    subtitle?: string;
    actions?: ReactNode;
    showBackButton?: boolean;
    onBack?: () => void;
    children: ReactNode;
    className?: string;
    width?: string;
}

interface AsidePanelHeaderProps {
    title: string;
    subtitle?: string;
    actions?: ReactNode;
    onBack?: () => void;
    onClose: () => void;
    showBackButton?: boolean;
}

// Header Component
export const AsidePanelHeader: React.FC<AsidePanelHeaderProps> = ({
    title,
    subtitle,
    actions,
    onBack,
    onClose,
    showBackButton = false,
}) => {
    return (
        <div className="px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag shrink-0">
            <div className="flex items-center gap-2 min-w-0">
                {showBackButton && onBack && (
                    <button
                        onClick={onBack}
                        className="p-1 hover:bg-muted rounded-md transition-colors cursor-pointer shrink-0"
                    >
                        <ArrowLeft size={18} />
                    </button>
                )}
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold truncate">{title}</h3>
                    {subtitle && (
                        <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
                {actions}
                <button
                    onClick={onClose}
                    className="p-1.5 hover:bg-muted rounded-md transition-colors cursor-pointer"
                >
                    <X size={18} />
                </button>
            </div>
        </div>
    );
};

// Content Component (wraps children with scroll)
export const AsidePanelContent: React.FC<{ children: ReactNode; className?: string }> = ({
    children,
    className,
}) => {
    return (
        <ScrollArea className={cn("flex-1 min-w-0", className)}>
            <div className="p-4 space-y-4 min-w-0 overflow-x-hidden">
                {children}
            </div>
        </ScrollArea>
    );
};

// Footer Component
export const AsidePanelFooter: React.FC<{ children: ReactNode; className?: string }> = ({
    children,
    className,
}) => {
    return (
        <div className={cn("px-4 py-3 border-t border-border/60 shrink-0", className)}>
            {children}
        </div>
    );
};

// Action Menu Component (for the ... button)
interface AsideActionMenuProps {
    children: ReactNode;
}

export const AsideActionMenu: React.FC<AsideActionMenuProps> = ({ children }) => {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button className="p-1.5 hover:bg-muted rounded-md transition-colors cursor-pointer">
                    <MoreVertical size={18} />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="end">
                {children}
            </PopoverContent>
        </Popover>
    );
};

// Action Menu Item
export const AsideActionMenuItem: React.FC<{
    icon?: ReactNode;
    children: ReactNode;
    onClick?: () => void;
    variant?: 'default' | 'destructive';
}> = ({ icon, children, onClick, variant = 'default' }) => {
    return (
        <button
            onClick={onClick}
            className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors cursor-pointer",
                variant === 'destructive'
                    ? "text-destructive hover:bg-destructive/10"
                    : "hover:bg-muted"
            )}
        >
            {icon}
            {children}
        </button>
    );
};

// Main Panel Component with Stack Support
interface AsidePanelStackProps {
    open: boolean;
    onClose: () => void;
    initialItem: AsideContentItem;
    className?: string;
    width?: string;
}

export const AsidePanelStack: React.FC<AsidePanelStackProps> = ({
    open,
    onClose,
    initialItem,
    className,
    width = 'w-[380px]',
}) => {
    const [stack, setStack] = useState<AsideContentItem[]>([initialItem]);

    const push = useCallback((item: AsideContentItem) => {
        setStack(prev => [...prev, item]);
    }, []);

    const pop = useCallback(() => {
        setStack(prev => {
            if (prev.length > 1) {
                return prev.slice(0, -1);
            }
            return prev;
        });
    }, []);

    const replace = useCallback((item: AsideContentItem) => {
        setStack([item]);
    }, []);

    const clear = useCallback(() => {
        setStack([initialItem]);
    }, [initialItem]);

    const currentItem = stack[stack.length - 1];
    const canGoBack = stack.length > 1;

    // Reset stack when panel closes/opens
    React.useEffect(() => {
        if (open) {
            setStack([initialItem]);
        }
    }, [open, initialItem]);

    if (!open) return null;

    return (
        <AsidePanelContext.Provider value={{ push, pop, replace, clear, canGoBack, currentItem }}>
            <div className={cn(
                "absolute right-0 top-0 bottom-0 max-w-full border-l border-border/60 bg-background z-30 flex flex-col app-no-drag",
                width,
                className
            )}>
                <AsidePanelHeader
                    title={currentItem.title}
                    subtitle={currentItem.subtitle}
                    actions={currentItem.actions}
                    onBack={canGoBack ? pop : undefined}
                    onClose={onClose}
                    showBackButton={canGoBack}
                />
                {currentItem.content}
            </div>
        </AsidePanelContext.Provider>
    );
};

// Simple Panel Component (no stack)
export const AsidePanel: React.FC<AsidePanelProps> = ({
    open,
    onClose,
    title,
    subtitle,
    actions,
    showBackButton,
    onBack,
    children,
    className,
    width = 'w-[380px]',
}) => {
    if (!open) return null;

    return (
        <div className={cn(
            "absolute right-0 top-0 bottom-0 max-w-full border-l border-border/60 bg-background z-30 flex flex-col app-no-drag",
            width,
            className
        )}>
            {title && (
                <AsidePanelHeader
                    title={title}
                    subtitle={subtitle}
                    actions={actions}
                    onClose={onClose}
                    showBackButton={showBackButton}
                    onBack={onBack}
                />
            )}
            {children}
        </div>
    );
};

export default AsidePanel;
