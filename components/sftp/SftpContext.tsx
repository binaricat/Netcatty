/**
 * SftpContext - Provides stable callback references to SFTP components
 * 
 * This context eliminates props drilling of callback functions through
 * the component tree, significantly reducing re-renders caused by
 * callback reference changes.
 */

import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { SftpConnectedHostEntry } from "../../domain/sftpConnectedHosts";
import type { SftpConnectOptions } from "../../application/state/sftp/useSftpConnections";
import { Host, SftpFileEntry, SftpFilenameEncoding } from "../../types";

export interface SftpTransferSource {
    name: string;
    isDirectory: boolean;
    sourcePath?: string;
    sourceConnectionId?: string;
    targetPath?: string;
}

export type SftpConnectTarget = Host | "local";
export type SftpConnectHostOptions = Pick<SftpConnectOptions, "sourceSessionId">;

// Types for the context
export interface SftpPaneCallbacks {
    onConnect: (host: SftpConnectTarget, options?: SftpConnectHostOptions) => void;
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
    onOpenFileWithSystemDefault?: (entry: SftpFileEntry, fullPath?: string) => void;
    onOpenFileWith?: (entry: SftpFileEntry, fullPath?: string) => void;  // Always show opener dialog
    onDownloadFile?: (entry: SftpFileEntry, fullPath?: string) => void;  // Download to local filesystem
    onDownloadFiles?: (entries: SftpFileEntry[]) => void;  // Batch download — picks one target directory for remote panes
    onExtractArchive?: (entry: SftpFileEntry, fullPath?: string) => void | Promise<void>;
    // External file upload (supports folders via DataTransfer)
    onUploadExternalFiles?: (dataTransfer: DataTransfer, targetPath?: string) => Promise<void>;
    // External file upload from <input type="file" multiple> picker (FileList).
    onUploadExternalFileList?: (fileList: FileList, targetPath?: string) => Promise<void>;
    // External folder upload from native directory picker.
    onUploadExternalFolder?: (targetPath?: string) => Promise<void>;
    onListDirectory: (path: string) => Promise<SftpFileEntry[]>;
    onListDrives: () => Promise<string[]>;
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

export interface SftpHostsContextValue {
    // Hosts list for connection picker
    hosts: Host[];
    // Live terminal sessions that can be reused for SFTP (shown in picker).
    connectedHosts: SftpConnectedHostEntry[];
    // Raw hosts list for bookmark persistence and other host writes.
    writableHosts: Host[];
    // Host updater for bookmark persistence
    updateHosts: (hosts: Host[]) => void;
}

export interface SftpPaneCallbacksContextValue {
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;
}

/** @deprecated Prefer useSftpHosts / useSftpPaneCallbacks to avoid cross-churn. */
export type SftpContextValue = SftpHostsContextValue & SftpPaneCallbacksContextValue;

export interface SftpDragContextValue {
    draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
    dragCallbacks: SftpDragCallbacks;
}

const SftpHostsContext = createContext<SftpHostsContextValue | null>(null);
const SftpPaneCallbacksContext = createContext<SftpPaneCallbacksContextValue | null>(null);
const SftpDragContext = createContext<SftpDragContextValue | null>(null);

/** @deprecated Prefer selective hooks; this re-renders on hosts OR callbacks churn. */
export const useSftpContext = (): SftpContextValue => {
    const hosts = useContext(SftpHostsContext);
    const callbacks = useContext(SftpPaneCallbacksContext);
    if (!hosts || !callbacks) {
        throw new Error("useSftpContext must be used within SftpContextProvider");
    }
    return useMemo(
        () => ({ ...hosts, ...callbacks }),
        [hosts, callbacks],
    );
};

// Hook to get callbacks for a specific side
export const useSftpPaneCallbacks = (side: "left" | "right"): SftpPaneCallbacks => {
    const context = useContext(SftpPaneCallbacksContext);
    if (!context) {
        throw new Error("useSftpPaneCallbacks must be used within SftpContextProvider");
    }
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
    const context = useContext(SftpHostsContext);
    if (!context) {
        throw new Error("useSftpHosts must be used within SftpContextProvider");
    }
    return context.hosts;
};

// Hook to get currently connected terminal hosts for the picker
export const useSftpConnectedHosts = () => {
    const context = useContext(SftpHostsContext);
    if (!context) {
        throw new Error("useSftpConnectedHosts must be used within SftpContextProvider");
    }
    return context.connectedHosts;
};

// Hook to get raw hosts for writeback
export const useSftpWritableHosts = () => {
    const context = useContext(SftpHostsContext);
    if (!context) {
        throw new Error("useSftpWritableHosts must be used within SftpContextProvider");
    }
    return context.writableHosts;
};

// Hook to get host updater
export const useSftpUpdateHosts = () => {
    const context = useContext(SftpHostsContext);
    if (!context) {
        throw new Error("useSftpUpdateHosts must be used within SftpContextProvider");
    }
    return context.updateHosts;
};

interface SftpContextProviderProps {
    hosts: Host[];
    connectedHosts?: SftpConnectedHostEntry[];
    writableHosts?: Host[];
    updateHosts: (hosts: Host[]) => void;
    draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
    dragCallbacks: SftpDragCallbacks;
    leftCallbacks: SftpPaneCallbacks;
    rightCallbacks: SftpPaneCallbacks;
    children: React.ReactNode;
}

export const SftpContextProvider: React.FC<SftpContextProviderProps> = ({
    hosts,
    connectedHosts = [],
    writableHosts,
    updateHosts,
    draggedFiles,
    dragCallbacks,
    leftCallbacks,
    rightCallbacks,
    children,
}) => {
    // Hosts and pane callbacks are separate so hosts churn does not invalidate
    // callback consumers (and callback identity churn does not invalidate hosts).
    const hostsValue = useMemo<SftpHostsContextValue>(
        () => ({
            hosts,
            connectedHosts,
            writableHosts: writableHosts ?? hosts,
            updateHosts,
        }),
        [hosts, connectedHosts, writableHosts, updateHosts],
    );

    const callbacksValue = useMemo<SftpPaneCallbacksContextValue>(
        () => ({
            leftCallbacks,
            rightCallbacks,
        }),
        [leftCallbacks, rightCallbacks],
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
        <SftpHostsContext.Provider value={hostsValue}>
            <SftpPaneCallbacksContext.Provider value={callbacksValue}>
                <SftpDragContext.Provider value={dragValue}>{children}</SftpDragContext.Provider>
            </SftpPaneCallbacksContext.Provider>
        </SftpHostsContext.Provider>
    );
};
