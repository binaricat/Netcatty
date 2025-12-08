import { useState, useCallback, useRef, useEffect } from 'react';
import {
  SftpConnection,
  SftpFileEntry,
  TransferTask,
  TransferStatus,
  TransferDirection,
  FileConflict,
  Host,
  SSHKey,
} from '../../domain/models';

// Helper functions
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '--';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const formatDate = (timestamp: number): string => {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const getFileExtension = (name: string): string => {
  if (name === '..') return 'folder';
  const ext = name.split('.').pop()?.toLowerCase();
  return ext || 'file';
};

// Check if path is Windows-style
const isWindowsPath = (path: string): boolean => /^[A-Za-z]:/.test(path);

const joinPath = (base: string, name: string): string => {
  if (isWindowsPath(base)) {
    // Windows path
    const normalizedBase = base.replace(/[\\/]+$/, ''); // Remove trailing slashes
    return `${normalizedBase}\\${name}`;
  }
  // Unix path
  if (base === '/') return `/${name}`;
  return `${base}/${name}`;
};

const getParentPath = (path: string): string => {
  if (isWindowsPath(path)) {
    // Windows path
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || 'C:'; // Return drive root
    parts.pop();
    return parts.join('\\');
  }
  // Unix path
  if (path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
};

const getFileName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
};

export interface SftpPane {
  connection: SftpConnection | null;
  files: SftpFileEntry[];
  loading: boolean;
  error: string | null;
  selectedFiles: Set<string>;
  filter: string;
}

export const useSftpState = (hosts: Host[], keys: SSHKey[]) => {
  // Connections
  const [leftPane, setLeftPane] = useState<SftpPane>({
    connection: null,
    files: [],
    loading: false,
    error: null,
    selectedFiles: new Set(),
    filter: '',
  });
  
  const [rightPane, setRightPane] = useState<SftpPane>({
    connection: null,
    files: [],
    loading: false,
    error: null,
    selectedFiles: new Set(),
    filter: '',
  });

  // Transfer management
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);
  
  // SFTP session refs
  const sftpSessionsRef = useRef<Map<string, string>>(new Map()); // connectionId -> sftpId
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sftpSessionsRef.current.forEach(async (sftpId) => {
        try {
          await window.nebula?.closeSftp(sftpId);
        } catch {}
      });
    };
  }, []);

  // Get host credentials
  const getHostCredentials = useCallback((host: Host) => {
    const key = host.identityFileId ? keys.find(k => k.id === host.identityFileId) : null;
    return {
      hostname: host.hostname,
      username: host.username,
      port: host.port || 22,
      password: host.password,
      privateKey: key?.privateKey,
    };
  }, [keys]);

  // Connect to a host
  const connect = useCallback(async (side: 'left' | 'right', host: Host | 'local') => {
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    const connectionId = `${side}-${Date.now()}`;

    if (host === 'local') {
      // Local filesystem connection
      // Try to get home directory from backend, fallback to platform-specific default
      let homeDir = await window.nebula?.getHomeDir?.();
      if (!homeDir) {
        // Detect platform and use appropriate default
        const isWindows = navigator.platform.toLowerCase().includes('win');
        homeDir = isWindows ? 'C:\\Users\\damao' : '/Users/damao';
      }
      
      const connection: SftpConnection = {
        id: connectionId,
        hostId: 'local',
        hostLabel: 'Local',
        isLocal: true,
        status: 'connected',
        currentPath: homeDir,
        homeDir,
      };
      
      setPane(prev => ({
        ...prev,
        connection,
        loading: true,
        error: null,
      }));

      try {
        const files = await listLocalFiles(homeDir);
        setPane(prev => ({
          ...prev,
          files,
          loading: false,
        }));
      } catch (err) {
        setPane(prev => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Failed to list directory',
          loading: false,
        }));
      }
    } else {
      // Remote SFTP connection
      const connection: SftpConnection = {
        id: connectionId,
        hostId: host.id,
        hostLabel: host.label,
        isLocal: false,
        status: 'connecting',
        currentPath: '/',
      };

      setPane(prev => ({
        ...prev,
        connection,
        loading: true,
        error: null,
        files: [],
      }));

      try {
        const credentials = getHostCredentials(host);
        const sftpId = await window.nebula?.openSftp({
          sessionId: `sftp-${connectionId}`,
          ...credentials,
        });

        if (!sftpId) throw new Error('Failed to open SFTP session');
        
        sftpSessionsRef.current.set(connectionId, sftpId);

        // Try to get home directory, default to /
        let startPath = '/';
        try {
          const homeFiles = await window.nebula?.listSftp(sftpId, `/home/${credentials.username}`);
          if (homeFiles) startPath = `/home/${credentials.username}`;
        } catch {
          try {
            const rootFiles = await window.nebula?.listSftp(sftpId, '/root');
            if (rootFiles) startPath = '/root';
          } catch {}
        }

        const files = await listRemoteFiles(sftpId, startPath);

        setPane(prev => ({
          ...prev,
          connection: prev.connection ? {
            ...prev.connection,
            status: 'connected',
            currentPath: startPath,
            homeDir: startPath,
          } : null,
          files,
          loading: false,
        }));
      } catch (err) {
        setPane(prev => ({
          ...prev,
          connection: prev.connection ? {
            ...prev.connection,
            status: 'error',
            error: err instanceof Error ? err.message : 'Connection failed',
          } : null,
          error: err instanceof Error ? err.message : 'Connection failed',
          loading: false,
        }));
      }
    }
  }, [getHostCredentials]);

  // Disconnect
  const disconnect = useCallback(async (side: 'left' | 'right') => {
    const pane = side === 'left' ? leftPane : rightPane;
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    
    if (pane.connection && !pane.connection.isLocal) {
      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (sftpId) {
        try {
          await window.nebula?.closeSftp(sftpId);
        } catch {}
        sftpSessionsRef.current.delete(pane.connection.id);
      }
    }

    setPane({
      connection: null,
      files: [],
      loading: false,
      error: null,
      selectedFiles: new Set(),
      filter: '',
    });
  }, [leftPane, rightPane]);

  // Mock local file data for development (when backend is not available)
  const getMockLocalFiles = (path: string): SftpFileEntry[] => {
    // Normalize path for matching (handle both Windows and Unix paths)
    const normPath = path.replace(/\\/g, '/').replace(/\/$/, '') || '/';
    
    const mockData: Record<string, SftpFileEntry[]> = {
      // Unix-style paths
      '/': [
        { name: 'Users', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'Applications', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'System', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 259200000, lastModifiedFormatted: formatDate(Date.now() - 259200000) },
      ],
      '/Users': [
        { name: 'damao', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'Shared', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
      ],
      '/Users/damao': [
        { name: 'Desktop', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 1800000, lastModifiedFormatted: formatDate(Date.now() - 1800000) },
        { name: 'Documents', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'Downloads', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'Pictures', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'Projects', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 900000, lastModifiedFormatted: formatDate(Date.now() - 900000) },
      ],
      // Windows-style paths (normalized to forward slashes for matching)
      'C:': [
        { name: 'Users', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'Program Files', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'Windows', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 259200000, lastModifiedFormatted: formatDate(Date.now() - 259200000) },
      ],
      'C:/Users': [
        { name: 'damao', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'Public', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'Default', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
      ],
      'C:/Users/damao': [
        { name: 'Desktop', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 1800000, lastModifiedFormatted: formatDate(Date.now() - 1800000) },
        { name: 'Documents', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'Downloads', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'Pictures', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'Projects', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 900000, lastModifiedFormatted: formatDate(Date.now() - 900000) },
      ],
      'C:/Users/damao/Desktop': [
        { name: 'Netcatty', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 300000, lastModifiedFormatted: formatDate(Date.now() - 300000) },
        { name: 'notes.txt', type: 'file', size: 2048, sizeFormatted: '2 KB', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'screenshot.png', type: 'file', size: 1048576, sizeFormatted: '1 MB', lastModified: Date.now() - 43200000, lastModifiedFormatted: formatDate(Date.now() - 43200000) },
      ],
      'C:/Users/damao/Desktop/Netcatty': [
        { name: 'src', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 600000, lastModifiedFormatted: formatDate(Date.now() - 600000) },
        { name: 'package.json', type: 'file', size: 1536, sizeFormatted: '1.5 KB', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'README.md', type: 'file', size: 4096, sizeFormatted: '4 KB', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'tsconfig.json', type: 'file', size: 512, sizeFormatted: '512 Bytes', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
      ],
      'C:/Users/damao/Documents': [
        { name: 'Work', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'Personal', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'report.pdf', type: 'file', size: 2097152, sizeFormatted: '2 MB', lastModified: Date.now() - 259200000, lastModifiedFormatted: formatDate(Date.now() - 259200000) },
      ],
      'C:/Users/damao/Downloads': [
        { name: 'installer.exe', type: 'file', size: 52428800, sizeFormatted: '50 MB', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'archive.zip', type: 'file', size: 10485760, sizeFormatted: '10 MB', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'document.pdf', type: 'file', size: 524288, sizeFormatted: '512 KB', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
      ],
      'C:/Users/damao/Projects': [
        { name: 'webapp', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 1800000, lastModifiedFormatted: formatDate(Date.now() - 1800000) },
        { name: 'scripts', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 43200000, lastModifiedFormatted: formatDate(Date.now() - 43200000) },
      ],
      '/Users/damao/Desktop': [
        { name: 'Netcatty', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 300000, lastModifiedFormatted: formatDate(Date.now() - 300000) },
        { name: 'notes.txt', type: 'file', size: 2048, sizeFormatted: '2 KB', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'screenshot.png', type: 'file', size: 1048576, sizeFormatted: '1 MB', lastModified: Date.now() - 43200000, lastModifiedFormatted: formatDate(Date.now() - 43200000) },
      ],
      '/Users/damao/Desktop/Netcatty': [
        { name: 'src', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 600000, lastModifiedFormatted: formatDate(Date.now() - 600000) },
        { name: 'package.json', type: 'file', size: 1536, sizeFormatted: '1.5 KB', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'README.md', type: 'file', size: 4096, sizeFormatted: '4 KB', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'tsconfig.json', type: 'file', size: 512, sizeFormatted: '512 Bytes', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
      ],
      '/Users/damao/Documents': [
        { name: 'Work', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
        { name: 'Personal', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 172800000, lastModifiedFormatted: formatDate(Date.now() - 172800000) },
        { name: 'report.pdf', type: 'file', size: 2097152, sizeFormatted: '2 MB', lastModified: Date.now() - 259200000, lastModifiedFormatted: formatDate(Date.now() - 259200000) },
      ],
      '/Users/damao/Downloads': [
        { name: 'installer.exe', type: 'file', size: 52428800, sizeFormatted: '50 MB', lastModified: Date.now() - 3600000, lastModifiedFormatted: formatDate(Date.now() - 3600000) },
        { name: 'archive.zip', type: 'file', size: 10485760, sizeFormatted: '10 MB', lastModified: Date.now() - 7200000, lastModifiedFormatted: formatDate(Date.now() - 7200000) },
        { name: 'document.pdf', type: 'file', size: 524288, sizeFormatted: '512 KB', lastModified: Date.now() - 86400000, lastModifiedFormatted: formatDate(Date.now() - 86400000) },
      ],
      '/Users/damao/Projects': [
        { name: 'webapp', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 1800000, lastModifiedFormatted: formatDate(Date.now() - 1800000) },
        { name: 'scripts', type: 'directory', size: 0, sizeFormatted: '--', lastModified: Date.now() - 43200000, lastModifiedFormatted: formatDate(Date.now() - 43200000) },
      ],
    };
    return mockData[normPath] || [];
  };

  // List local files
  const listLocalFiles = async (path: string): Promise<SftpFileEntry[]> => {
    const rawFiles = await window.nebula?.listLocalDir?.(path);
    if (!rawFiles) {
      // Fallback mock for development
      return getMockLocalFiles(path);
    }
    
    return rawFiles.map(f => ({
      name: f.name,
      type: f.type as 'file' | 'directory' | 'symlink',
      size: parseInt(f.size) || 0,
      sizeFormatted: f.size,
      lastModified: new Date(f.lastModified).getTime(),
      lastModifiedFormatted: f.lastModified,
    }));
  };

  // List remote files
  const listRemoteFiles = async (sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    const rawFiles = await window.nebula?.listSftp(sftpId, path);
    if (!rawFiles) return [];

    return rawFiles.map(f => ({
      name: f.name,
      type: f.type as 'file' | 'directory' | 'symlink',
      size: parseInt(f.size) || 0,
      sizeFormatted: f.size,
      lastModified: new Date(f.lastModified).getTime(),
      lastModifiedFormatted: f.lastModified,
    }));
  };

  // Navigate to path
  const navigateTo = useCallback(async (side: 'left' | 'right', path: string) => {
    const pane = side === 'left' ? leftPane : rightPane;
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    
    if (!pane.connection) return;

    setPane(prev => ({ ...prev, loading: true, error: null }));

    try {
      let files: SftpFileEntry[];
      
      if (pane.connection.isLocal) {
        files = await listLocalFiles(path);
      } else {
        const sftpId = sftpSessionsRef.current.get(pane.connection.id);
        if (!sftpId) throw new Error('SFTP session not found');
        files = await listRemoteFiles(sftpId, path);
      }

      setPane(prev => ({
        ...prev,
        connection: prev.connection ? { ...prev.connection, currentPath: path } : null,
        files,
        loading: false,
        selectedFiles: new Set(),
      }));
    } catch (err) {
      setPane(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to list directory',
        loading: false,
      }));
    }
  }, [leftPane, rightPane]);

  // Refresh current directory
  const refresh = useCallback(async (side: 'left' | 'right') => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (pane.connection) {
      await navigateTo(side, pane.connection.currentPath);
    }
  }, [leftPane, rightPane, navigateTo]);

  // Navigate up
  const navigateUp = useCallback(async (side: 'left' | 'right') => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection) return;
    
    const currentPath = pane.connection.currentPath;
    // Check if we're at root (Unix "/" or Windows "C:")
    const isAtRoot = currentPath === '/' || /^[A-Za-z]:[\\/]?$/.test(currentPath);
    
    if (!isAtRoot) {
      const parentPath = getParentPath(currentPath);
      await navigateTo(side, parentPath);
    }
  }, [leftPane, rightPane, navigateTo]);

  // Open file/directory
  const openEntry = useCallback(async (side: 'left' | 'right', entry: SftpFileEntry) => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection) return;

    if (entry.name === '..') {
      await navigateUp(side);
      return;
    }

    if (entry.type === 'directory') {
      const newPath = joinPath(pane.connection.currentPath, entry.name);
      await navigateTo(side, newPath);
    }
    // TODO: Handle file open/preview
  }, [leftPane, rightPane, navigateTo, navigateUp]);

  // Selection management
  const toggleSelection = useCallback((side: 'left' | 'right', fileName: string, multiSelect: boolean) => {
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    
    setPane(prev => {
      const newSelection = new Set(multiSelect ? prev.selectedFiles : []);
      if (newSelection.has(fileName)) {
        newSelection.delete(fileName);
      } else {
        newSelection.add(fileName);
      }
      return { ...prev, selectedFiles: newSelection };
    });
  }, []);

  const clearSelection = useCallback((side: 'left' | 'right') => {
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    setPane(prev => ({ ...prev, selectedFiles: new Set() }));
  }, []);

  const selectAll = useCallback((side: 'left' | 'right') => {
    const pane = side === 'left' ? leftPane : rightPane;
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    
    setPane(prev => ({
      ...prev,
      selectedFiles: new Set(pane.files.filter(f => f.name !== '..').map(f => f.name)),
    }));
  }, [leftPane, rightPane]);

  // Filter
  const setFilter = useCallback((side: 'left' | 'right', filter: string) => {
    const setPane = side === 'left' ? setLeftPane : setRightPane;
    setPane(prev => ({ ...prev, filter }));
  }, []);

  // Create directory
  const createDirectory = useCallback(async (side: 'left' | 'right', name: string) => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection) return;

    const fullPath = joinPath(pane.connection.currentPath, name);

    try {
      if (pane.connection.isLocal) {
        await window.nebula?.mkdirLocal?.(fullPath);
      } else {
        const sftpId = sftpSessionsRef.current.get(pane.connection.id);
        if (!sftpId) throw new Error('SFTP session not found');
        await window.nebula?.mkdirSftp(sftpId, fullPath);
      }
      await refresh(side);
    } catch (err) {
      throw err;
    }
  }, [leftPane, rightPane, refresh]);

  // Delete files
  const deleteFiles = useCallback(async (side: 'left' | 'right', fileNames: string[]) => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection) return;

    try {
      for (const name of fileNames) {
        const fullPath = joinPath(pane.connection.currentPath, name);
        
        if (pane.connection.isLocal) {
          await window.nebula?.deleteLocalFile?.(fullPath);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) throw new Error('SFTP session not found');
          await window.nebula?.deleteSftp?.(sftpId, fullPath);
        }
      }
      await refresh(side);
    } catch (err) {
      throw err;
    }
  }, [leftPane, rightPane, refresh]);

  // Rename file
  const renameFile = useCallback(async (side: 'left' | 'right', oldName: string, newName: string) => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection) return;

    const oldPath = joinPath(pane.connection.currentPath, oldName);
    const newPath = joinPath(pane.connection.currentPath, newName);

    try {
      if (pane.connection.isLocal) {
        await window.nebula?.renameLocalFile?.(oldPath, newPath);
      } else {
        const sftpId = sftpSessionsRef.current.get(pane.connection.id);
        if (!sftpId) throw new Error('SFTP session not found');
        await window.nebula?.renameSftp?.(sftpId, oldPath, newPath);
      }
      await refresh(side);
    } catch (err) {
      throw err;
    }
  }, [leftPane, rightPane, refresh]);

  // Transfer files
  const startTransfer = useCallback(async (
    sourceFiles: { name: string; isDirectory: boolean }[],
    sourceSide: 'left' | 'right',
    targetSide: 'left' | 'right'
  ) => {
    const sourcePane = sourceSide === 'left' ? leftPane : rightPane;
    const targetPane = targetSide === 'left' ? leftPane : rightPane;

    if (!sourcePane.connection || !targetPane.connection) return;

    const sourcePath = sourcePane.connection.currentPath;
    const targetPath = targetPane.connection.currentPath;

    // Create transfer tasks
    const newTasks: TransferTask[] = sourceFiles.map(file => {
      const direction: TransferDirection = 
        sourcePane.connection!.isLocal && !targetPane.connection!.isLocal ? 'upload' :
        !sourcePane.connection!.isLocal && targetPane.connection!.isLocal ? 'download' :
        'remote-to-remote';

      return {
        id: crypto.randomUUID(),
        fileName: file.name,
        sourcePath: joinPath(sourcePath, file.name),
        targetPath: joinPath(targetPath, file.name),
        sourceConnectionId: sourcePane.connection!.id,
        targetConnectionId: targetPane.connection!.id,
        direction,
        status: 'pending' as TransferStatus,
        totalBytes: 0,
        transferredBytes: 0,
        speed: 0,
        startTime: Date.now(),
        isDirectory: file.isDirectory,
      };
    });

    setTransfers(prev => [...prev, ...newTasks]);

    // Process transfers
    for (const task of newTasks) {
      await processTransfer(task, sourcePane, targetPane);
    }
  }, [leftPane, rightPane]);

  // Process a single transfer
  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane
  ) => {
    const updateTask = (updates: Partial<TransferTask>) => {
      setTransfers(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t));
    };

    updateTask({ status: 'transferring' });

    try {
      const sourceSftpId = sourcePane.connection?.isLocal ? null : 
        sftpSessionsRef.current.get(sourcePane.connection!.id);
      const targetSftpId = targetPane.connection?.isLocal ? null :
        sftpSessionsRef.current.get(targetPane.connection!.id);

      // Check if file already exists at target (conflict detection)
      if (!task.isDirectory) {
        let targetExists = false;
        let existingStat: { size: number; mtime: number } | null = null;
        
        try {
          if (targetPane.connection?.isLocal) {
            const stat = await window.nebula?.statLocal?.(task.targetPath);
            if (stat) {
              targetExists = true;
              existingStat = { size: stat.size, mtime: stat.lastModified || Date.now() };
            }
          } else if (targetSftpId && window.nebula?.statSftp) {
            const stat = await window.nebula.statSftp(targetSftpId, task.targetPath);
            if (stat) {
              targetExists = true;
              existingStat = { size: stat.size, mtime: stat.lastModified || Date.now() };
            }
          }
        } catch {
          // File doesn't exist, no conflict
        }

        if (targetExists && existingStat) {
          // Add conflict for user to resolve
          const newConflict: FileConflict = {
            transferId: task.id,
            fileName: task.fileName,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            existingSize: existingStat.size,
            newSize: task.totalBytes,
            existingModified: existingStat.mtime,
            newModified: Date.now(),
          };
          setConflicts(prev => [...prev, newConflict]);
          updateTask({ status: 'pending' }); // Wait for user decision
          return;
        }
      }

      if (task.isDirectory) {
        // Handle directory transfer recursively
        await transferDirectory(task, sourceSftpId, targetSftpId, sourcePane.connection!.isLocal, targetPane.connection!.isLocal);
      } else {
        // Handle file transfer
        await transferFile(task, sourceSftpId, targetSftpId, sourcePane.connection!.isLocal, targetPane.connection!.isLocal);
      }

      updateTask({ status: 'completed', endTime: Date.now() });
      
      // Refresh target pane
      const targetSide = targetPane === leftPane ? 'left' : 'right';
      await refresh(targetSide as 'left' | 'right');
    } catch (err) {
      updateTask({ 
        status: 'failed', 
        error: err instanceof Error ? err.message : 'Transfer failed',
        endTime: Date.now(),
      });
    }
  };

  // Transfer a single file
  const transferFile = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean
  ) => {
    let content: ArrayBuffer | string;

    // Read from source
    if (sourceIsLocal) {
      content = await window.nebula?.readLocalFile?.(task.sourcePath) || new ArrayBuffer(0);
    } else if (sourceSftpId) {
      if (window.nebula?.readSftpBinary) {
        content = await window.nebula.readSftpBinary(sourceSftpId, task.sourcePath);
      } else {
        content = await window.nebula?.readSftp(sourceSftpId, task.sourcePath) || '';
      }
    } else {
      throw new Error('No source connection');
    }

    // Write to target
    if (targetIsLocal) {
      if (content instanceof ArrayBuffer) {
        await window.nebula?.writeLocalFile?.(task.targetPath, content);
      } else {
        const encoder = new TextEncoder();
        await window.nebula?.writeLocalFile?.(task.targetPath, encoder.encode(content).buffer);
      }
    } else if (targetSftpId) {
      if (content instanceof ArrayBuffer && window.nebula?.writeSftpBinary) {
        await window.nebula.writeSftpBinary(targetSftpId, task.targetPath, content);
      } else {
        const text = content instanceof ArrayBuffer 
          ? new TextDecoder().decode(content) 
          : content;
        await window.nebula?.writeSftp(targetSftpId, task.targetPath, text);
      }
    } else {
      throw new Error('No target connection');
    }
  };

  // Transfer a directory
  const transferDirectory = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean
  ) => {
    // Create target directory
    if (targetIsLocal) {
      await window.nebula?.mkdirLocal?.(task.targetPath);
    } else if (targetSftpId) {
      await window.nebula?.mkdirSftp(targetSftpId, task.targetPath);
    }

    // List source directory
    let files: SftpFileEntry[];
    if (sourceIsLocal) {
      files = await listLocalFiles(task.sourcePath);
    } else if (sourceSftpId) {
      files = await listRemoteFiles(sourceSftpId, task.sourcePath);
    } else {
      throw new Error('No source connection');
    }

    // Transfer each item
    for (const file of files) {
      if (file.name === '..') continue;

      const childTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        fileName: file.name,
        sourcePath: joinPath(task.sourcePath, file.name),
        targetPath: joinPath(task.targetPath, file.name),
        isDirectory: file.type === 'directory',
        parentTaskId: task.id,
      };

      if (file.type === 'directory') {
        await transferDirectory(childTask, sourceSftpId, targetSftpId, sourceIsLocal, targetIsLocal);
      } else {
        await transferFile(childTask, sourceSftpId, targetSftpId, sourceIsLocal, targetIsLocal);
      }
    }
  };

  // Cancel transfer
  const cancelTransfer = useCallback(async (transferId: string) => {
    setTransfers(prev => prev.map(t => 
      t.id === transferId ? { ...t, status: 'cancelled' as TransferStatus, endTime: Date.now() } : t
    ));
    await window.nebula?.cancelTransfer?.(transferId);
  }, []);

  // Retry failed transfer
  const retryTransfer = useCallback(async (transferId: string) => {
    const task = transfers.find(t => t.id === transferId);
    if (!task) return;

    const sourcePane = task.sourceConnectionId.startsWith('left') ? leftPane : rightPane;
    const targetPane = task.targetConnectionId.startsWith('left') ? leftPane : rightPane;

    if (sourcePane.connection && targetPane.connection) {
      setTransfers(prev => prev.map(t => 
        t.id === transferId ? { ...t, status: 'pending' as TransferStatus, error: undefined } : t
      ));
      await processTransfer(task, sourcePane, targetPane);
    }
  }, [transfers, leftPane, rightPane]);

  // Clear completed transfers
  const clearCompletedTransfers = useCallback(() => {
    setTransfers(prev => prev.filter(t => t.status !== 'completed' && t.status !== 'cancelled'));
  }, []);

  // Dismiss transfer
  const dismissTransfer = useCallback((transferId: string) => {
    setTransfers(prev => prev.filter(t => t.id !== transferId));
  }, []);

  // Handle file conflict
  const resolveConflict = useCallback((conflictId: string, action: 'replace' | 'skip' | 'duplicate') => {
    const conflict = conflicts.find(c => c.transferId === conflictId);
    if (!conflict) return;

    // Remove from conflicts list
    setConflicts(prev => prev.filter(c => c.transferId !== conflictId));

    // Handle based on action
    setTransfers(prev => prev.map(t => {
      if (t.id !== conflictId) return t;
      
      switch (action) {
        case 'skip':
          // Mark as cancelled
          return { ...t, status: 'cancelled' as TransferStatus };
        case 'replace':
          // Mark as pending to continue transfer (will overwrite)
          return { ...t, status: 'pending' as TransferStatus };
        case 'duplicate':
          // Generate new name and update task
          const ext = t.fileName.includes('.') ? '.' + t.fileName.split('.').pop() : '';
          const baseName = t.fileName.includes('.') 
            ? t.fileName.slice(0, t.fileName.lastIndexOf('.'))
            : t.fileName;
          const newName = `${baseName} (copy)${ext}`;
          const newTargetPath = t.targetPath.replace(t.fileName, newName);
          return { 
            ...t, 
            fileName: newName,
            targetPath: newTargetPath,
            status: 'pending' as TransferStatus 
          };
        default:
          return t;
      }
    }));
  }, [conflicts]);

  // Get filtered files
  const getFilteredFiles = (pane: SftpPane): SftpFileEntry[] => {
    const term = pane.filter.trim().toLowerCase();
    if (!term) return pane.files;
    return pane.files.filter(f => f.name === '..' || f.name.toLowerCase().includes(term));
  };

  // Get active transfers count
  const activeTransfersCount = transfers.filter(t => 
    t.status === 'pending' || t.status === 'transferring'
  ).length;

  // Change file permissions (SFTP only)
  const changePermissions = useCallback(async (
    side: 'left' | 'right',
    filePath: string,
    mode: string // octal string like "755"
  ) => {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane.connection || pane.connection.isLocal) {
      console.warn('Cannot change permissions on local files');
      return;
    }
    
    const sftpId = sftpSessionsRef.current.get(pane.connection.id);
    if (!sftpId || !window.nebula?.chmodSftp) {
      console.warn('chmod not available');
      return;
    }
    
    try {
      await window.nebula.chmodSftp(sftpId, filePath, mode);
      await refresh(side);
    } catch (err) {
      console.error('Failed to change permissions:', err);
    }
  }, [leftPane, rightPane, refresh]);

  return {
    // Panes
    leftPane,
    rightPane,
    getFilteredFiles,
    
    // Connection
    connect,
    disconnect,
    
    // Navigation
    navigateTo,
    navigateUp,
    refresh,
    openEntry,
    
    // Selection
    toggleSelection,
    clearSelection,
    selectAll,
    setFilter,
    
    // File operations
    createDirectory,
    deleteFiles,
    renameFile,
    changePermissions,
    
    // Transfers
    transfers,
    activeTransfersCount,
    startTransfer,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    
    // Conflicts
    conflicts,
    resolveConflict,
    
    // Helpers
    formatFileSize,
    formatDate,
    getFileExtension,
    joinPath,
    getParentPath,
    getFileName,
  };
};
