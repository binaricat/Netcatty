/**
 * SftpContext - Provides stable callback references to SFTP components
 * 
 * This context eliminates props drilling of callback functions through
 * the component tree, significantly reducing re-renders caused by
 * callback reference changes.
 */

import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { Host, SftpFileEntry, SftpFilenameEncoding } from "../../types";

export interface SftpTransferSource {
    name: string;
    isDirectory: boolean;
    sourcePath?: string;
    sourceConnectionId?: string;
    targetPath?: string;
}

// Types for the context
export interface SftpPaneCallbacks {
    onConnect: (host: Host | "local") => void;
    /** Resolves true if disconnect completed, false if the user canceled the
     * dirty-editor prompt. Callers that follow up with a replacement connect
     * must gate on the result. */
    onDisconnect: () => Promise<boolean>;
    onPrepareSelection: () => void;
    onNavigateTo: (path: string) => void;
    onNavigateUp: () => void;
    onRefresh: () => void;
    onRefreshTab: (tabId: string) => void;
    onSetFilenameEncoding: (encoding: SftpFilenameEncoding) => void;
    onOpenEntry: (entry: SftpFileEntry, fullPath?: string) => void;
    onToggleSelection: (fileName: string, multiSelect: boolean) => void;
    onRangeSelect: (fileNames: string[]) => void;
    onClearSelection: () => void;
    onSetFilter: (filter: string) => void;
    onCreateDirectory: (name: string) => Promise<void>;
    onCreateDirectoryAtPath: (path: string, name: string) => Promise<void>;
    onCreateFile: (name: string) => Promise<void>;
    onCreateFileAtPath: (path: string, name: string) => Promise<void>;
    onDeleteFiles: (fileNames: string[]) => Promise<void>;
    onDeleteFilesAtPath: (connectionId: string, path: string, fileNames: string[]) => Promise<void>;
    onRenameFile: (oldName: string, newName: string) => Promise<void>;
    onRenameFileAtPath: (oldPath: string, newName: string) => Promise<void>;
    onMoveEntriesToPath: (sourcePaths: string[], targetPath: string) => Promise<void>;
    onCopyToOtherPane: (files: SftpTransferSource[]) => void;
    onReceiveFromOtherPane: (files: SftpTransferSource[]) => void;
    onEditPermissions?: (file: SftpFileEntry, fullPath?: string) => void;
    // File operations
    onEditFile?: (entry: SftpFileEntry, fullPath?: string) => void;
    onOpenFile?: (entry: SftpFileEntry, fullPath?: string) => void;
    onOpenFileWith?: (entry: SftpFileEntry, fullPath?: string) => void;  // Always show opener dialog
    onDownloadFile?: (entry: SftpFileEntry, fullPath?: string) => void;  // Download to local filesystem
    // External file upload (supports folders via DataTransfer)
    onUploadExternalFiles?: (dataTransfer: DataTransfer, targetPath?: string) => Promise<void>;
    onListDirectory: (path: string) => Promise<SftpFileEntry[]>;
}

export interface SftpDragCallbacks {
    onDragStart: (files: SftpTransferSource[], side: "left" | "right") => void;
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

    // Callbacks for each side
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;
}

export interface SftpDragContextValue {
    draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
    dragCallbacks: SftpDragCallbacks;
}

const SftpContext = createContext<SftpContextValue | null>(null);
const SftpDragContext = createContext<SftpDragContextValue | null>(null);

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

// Hook to get drag-related values (reads from separate SftpDragContext)
export const useSftpDrag = () => {
    const context = useContext(SftpDragContext);
    if (!context) {
        throw new Error("useSftpDrag must be used within SftpContextProvider");
    }
    return useMemo(
        () => ({
            draggedFiles: context.draggedFiles,
            ...context.dragCallbacks,
        }),
        [context.draggedFiles, context.dragCallbacks],
    );
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

interface SftpContextProviderProps {
    hosts: Host[];
    updateHosts: (hosts: Host[]) => void;
    draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
    dragCallbacks: SftpDragCallbacks;
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;
    children: React.ReactNode;
}

export const SftpContextProvider: React.FC<SftpContextProviderProps> = ({
    hosts,
    updateHosts,
    draggedFiles,
    dragCallbacks,
    leftCallbacks,
    rightCallbacks,
    children,
}) => {
    // Memoize the main context value (no drag state, so drag changes won't cause re-renders here)
    const value = useMemo<SftpContextValue>(
        () => ({
            hosts,
            updateHosts,
            leftCallbacks,
            rightCallbacks,
        }),
        [hosts, updateHosts, leftCallbacks, rightCallbacks],
    );

    // Memoize drag context separately so only drag consumers re-render on drag state changes
    const dragValue = useMemo<SftpDragContextValue>(
        () => ({
            draggedFiles,
            dragCallbacks,
        }),
        [draggedFiles, dragCallbacks],
    );

    return (
        <SftpContext.Provider value={value}>
            <SftpDragContext.Provider value={dragValue}>{children}</SftpDragContext.Provider>
        </SftpContext.Provider>
    );
};
