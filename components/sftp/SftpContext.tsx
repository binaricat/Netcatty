/**
 * SftpContext - Provides stable callback references to SFTP components
 * 
 * This context eliminates props drilling of callback functions through
 * the component tree, significantly reducing re-renders caused by
 * callback reference changes.
 */

import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { Host, SftpFileEntry, SftpFilenameEncoding } from "../../types";

// Types for the context
export interface SftpPaneCallbacks {
    onConnect: (host: Host | "local") => void;
    onDisconnect: () => void;
    onNavigateTo: (path: string) => void;
    onNavigateUp: () => void;
    onRefresh: () => void;
    onSetFilenameEncoding: (encoding: SftpFilenameEncoding) => void;
    onOpenEntry: (entry: SftpFileEntry) => void;
    onToggleSelection: (fileName: string, multiSelect: boolean) => void;
    onRangeSelect: (fileNames: string[]) => void;
    onClearSelection: () => void;
    onSetFilter: (filter: string) => void;
    onCreateDirectory: (name: string) => Promise<void>;
    onCreateFile: (name: string) => Promise<void>;
    onDeleteFiles: (fileNames: string[]) => Promise<void>;
    onRenameFile: (oldName: string, newName: string) => Promise<void>;
    onCopyToOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
    onReceiveFromOtherPane: (files: { name: string; isDirectory: boolean }[]) => void;
    onEditPermissions?: (file: SftpFileEntry) => void;
    // File operations
    onEditFile?: (entry: SftpFileEntry) => void;
    onOpenFile?: (entry: SftpFileEntry) => void;
    onOpenFileWith?: (entry: SftpFileEntry) => void;  // Always show opener dialog
    onDownloadFile?: (entry: SftpFileEntry) => void;  // Download to local filesystem
    // External file upload (supports folders via DataTransfer)
    onUploadExternalFiles?: (dataTransfer: DataTransfer) => Promise<void>;
}

export interface SftpDragCallbacks {
    onDragStart: (files: { name: string; isDirectory: boolean }[], side: "left" | "right") => void;
    onDragEnd: () => void;
}

// Store for activeTabId - allows subscription without re-rendering parent
type ActiveTabStore = {
    left: string | null;
    right: string | null;
};

type ActiveTabListener = () => void;

let activeTabState: ActiveTabStore = { left: null, right: null };
const activeTabListeners = new Set<ActiveTabListener>();

export const activeTabStore = {
    getSnapshot: () => activeTabState,
    getLeftActiveTabId: () => activeTabState.left,
    getRightActiveTabId: () => activeTabState.right,
    setActiveTabId: (side: "left" | "right", tabId: string | null) => {
        if (activeTabState[side] !== tabId) {
            activeTabState = { ...activeTabState, [side]: tabId };
            activeTabListeners.forEach((listener) => listener());
        }
    },
    subscribe: (listener: ActiveTabListener) => {
        activeTabListeners.add(listener);
        return () => activeTabListeners.delete(listener);
    },
};

// Hook to subscribe to active tab changes for a specific side
export const useActiveTabId = (side: "left" | "right"): string | null => {
    return useSyncExternalStore(
        activeTabStore.subscribe,
        () => (side === "left" ? activeTabStore.getLeftActiveTabId() : activeTabStore.getRightActiveTabId()),
        () => (side === "left" ? activeTabStore.getLeftActiveTabId() : activeTabStore.getRightActiveTabId()),
    );
};

// Hook to check if a specific pane is active (for CSS control)
export const useIsPaneActive = (side: "left" | "right", paneId: string): boolean => {
    const activeTabId = useActiveTabId(side);
    return activeTabId === paneId || (activeTabId === null && paneId !== null);
};

export interface SftpContextValue {
    // Hosts list for connection picker
    hosts: Host[];
    // Host updater for bookmark persistence
    updateHosts: (hosts: Host[]) => void;

    // Drag state (shared between panes)
    draggedFiles: { name: string; isDirectory: boolean; side: "left" | "right" }[] | null;
    dragCallbacks: SftpDragCallbacks;

    // Callbacks for each side
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;

    // Settings
    showHiddenFiles: boolean;
}

const SftpContext = createContext<SftpContextValue | null>(null);

export const useSftpContext = () => {
    const context = useContext(SftpContext);
    if (!context) {
        throw new Error("useSftpContext must be used within SftpContextProvider");
    }
    return context;
};

// Hook to get callbacks for a specific side
export const useSftpPaneCallbacks = (side: "left" | "right"): SftpPaneCallbacks => {
    const context = useSftpContext();
    return side === "left" ? context.leftCallbacks : context.rightCallbacks;
};

// Hook to get drag-related values
export const useSftpDrag = () => {
    const context = useSftpContext();
    return {
        draggedFiles: context.draggedFiles,
        ...context.dragCallbacks,
    };
};

// Hook to get hosts
export const useSftpHosts = () => {
    const context = useSftpContext();
    return context.hosts;
};

// Hook to get host updater
export const useSftpUpdateHosts = () => {
    const context = useSftpContext();
    return context.updateHosts;
};

// Hook to get showHiddenFiles setting
export const useSftpShowHiddenFiles = (): boolean => {
    const context = useSftpContext();
    return context.showHiddenFiles;
};

interface SftpContextProviderProps {
    hosts: Host[];
    updateHosts: (hosts: Host[]) => void;
    draggedFiles: { name: string; isDirectory: boolean; side: "left" | "right" }[] | null;
    dragCallbacks: SftpDragCallbacks;
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;
    showHiddenFiles: boolean;
    children: React.ReactNode;
}

export const SftpContextProvider: React.FC<SftpContextProviderProps> = ({
    hosts,
    updateHosts,
    draggedFiles,
    dragCallbacks,
    leftCallbacks,
    rightCallbacks,
    showHiddenFiles,
    children,
}) => {
    // Memoize the context value to prevent unnecessary re-renders
    // Note: The callbacks objects should be stable (created with useMemo in parent)
    const value = useMemo<SftpContextValue>(
        () => ({
            hosts,
            updateHosts,
            draggedFiles,
            dragCallbacks,
            leftCallbacks,
            rightCallbacks,
            showHiddenFiles,
        }),
        [hosts, updateHosts, draggedFiles, dragCallbacks, leftCallbacks, rightCallbacks, showHiddenFiles],
    );

    return <SftpContext.Provider value={value}>{children}</SftpContext.Provider>;
};
