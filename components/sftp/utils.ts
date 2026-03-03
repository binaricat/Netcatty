/**
 * SFTP utility functions for formatting and file type detection
 */

import {
    Database,
    ExternalLink,
    File,
    FileArchive,
    FileAudio,
    FileCode,
    FileImage,
    FileSpreadsheet,
    FileText,
    FileType,
    FileVideo,
    Folder,
    Globe,
    Key,
    Lock,
    Settings,
    Terminal,
} from 'lucide-react';
import React from 'react';
import { SftpFileEntry } from '../../types';

/**
 * Format bytes with appropriate unit (B, KB, MB, GB)
 */
export const formatBytes = (bytes: number | string): string => {
    const numBytes = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
    if (isNaN(numBytes) || numBytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(numBytes) / Math.log(1024));
    const size = numBytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Format bytes for transfer display
 */
export const formatTransferBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Format date as YYYY-MM-DD hh:mm in local timezone
 */
export const formatDate = (timestamp: number | undefined): string => {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '--';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * Format speed with appropriate unit
 */
export const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond <= 0) return '';
    if (bytesPerSecond >= 1024 * 1024) {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
};

/**
 * Comprehensive file icon helper - returns JSX element based on file type
 */
export const getFileIcon = (entry: SftpFileEntry): React.ReactElement => {
    if (entry.type === 'directory') return React.createElement(Folder, { size: 14 });

    // For symlink files (not directories), show a special symlink icon
    if (entry.type === 'symlink' && entry.linkTarget !== 'directory') {
        return React.createElement(ExternalLink, { size: 14, className: "text-cyan-500" });
    }

    const ext = entry.name.split('.').pop()?.toLowerCase() || '';

    // Documents
    if (['doc', 'docx', 'rtf', 'odt'].includes(ext))
        return React.createElement(FileText, { size: 14, className: "text-blue-500" });
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext))
        return React.createElement(FileSpreadsheet, { size: 14, className: "text-green-500" });
    if (['ppt', 'pptx', 'odp'].includes(ext))
        return React.createElement(FileType, { size: 14, className: "text-orange-500" });
    if (['pdf'].includes(ext))
        return React.createElement(FileText, { size: 14, className: "text-red-500" });

    // Code/Scripts
    if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-yellow-500" });
    if (['py', 'pyc', 'pyw'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-blue-400" });
    if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext))
        return React.createElement(Terminal, { size: 14, className: "text-green-400" });
    if (['c', 'cpp', 'h', 'hpp', 'cc', 'cxx'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-blue-600" });
    if (['java', 'class', 'jar'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-orange-600" });
    if (['go'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-cyan-500" });
    if (['rs'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-orange-400" });
    if (['rb'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-red-400" });
    if (['php'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-purple-500" });
    if (['html', 'htm', 'xhtml'].includes(ext))
        return React.createElement(Globe, { size: 14, className: "text-orange-500" });
    if (['css', 'scss', 'sass', 'less'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-blue-500" });
    if (['vue', 'svelte'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-green-500" });

    // Config/Data
    if (['json', 'json5'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-yellow-600" });
    if (['xml', 'xsl', 'xslt'].includes(ext))
        return React.createElement(FileCode, { size: 14, className: "text-orange-400" });
    if (['yml', 'yaml'].includes(ext))
        return React.createElement(Settings, { size: 14, className: "text-pink-400" });
    if (['toml', 'ini', 'conf', 'cfg', 'config'].includes(ext))
        return React.createElement(Settings, { size: 14, className: "text-gray-400" });
    if (['env'].includes(ext))
        return React.createElement(Lock, { size: 14, className: "text-yellow-500" });
    if (['sql', 'sqlite', 'db'].includes(ext))
        return React.createElement(Database, { size: 14, className: "text-blue-400" });

    // Images
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif'].includes(ext))
        return React.createElement(FileImage, { size: 14, className: "text-purple-400" });

    // Videos
    if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpeg', 'mpg'].includes(ext))
        return React.createElement(FileVideo, { size: 14, className: "text-pink-500" });

    // Audio
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'].includes(ext))
        return React.createElement(FileAudio, { size: 14, className: "text-green-400" });

    // Archives
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2', 'lz', 'lzma', 'cab', 'iso', 'dmg'].includes(ext))
        return React.createElement(FileArchive, { size: 14, className: "text-amber-500" });

    // Executables
    if (['exe', 'msi', 'app', 'deb', 'rpm', 'apk', 'ipa'].includes(ext))
        return React.createElement(File, { size: 14, className: "text-red-400" });
    if (['dll', 'so', 'dylib'].includes(ext))
        return React.createElement(File, { size: 14, className: "text-gray-500" });

    // Keys/Certs
    if (['pem', 'crt', 'cer', 'key', 'pub', 'ppk'].includes(ext))
        return React.createElement(Key, { size: 14, className: "text-yellow-400" });

    // Text/Markdown
    if (['md', 'markdown', 'mdx'].includes(ext))
        return React.createElement(FileText, { size: 14, className: "text-gray-400" });
    if (['txt', 'log', 'text'].includes(ext))
        return React.createElement(FileText, { size: 14, className: "text-muted-foreground" });

    // Default
    return React.createElement(FileCode, { size: 14 });
};

// Sort configuration types
export type SortField = 'name' | 'size' | 'modified' | 'type';
export type SortOrder = 'asc' | 'desc';

// Column widths type
export interface ColumnWidths {
    name: number;
    modified: number;
    size: number;
    type: number;
}

/**
 * Check if an entry is navigable like a directory
 * This includes regular directories and symlinks that point to directories
 */
export const isNavigableDirectory = (entry: SftpFileEntry): boolean => {
    return entry.type === 'directory' || (entry.type === 'symlink' && entry.linkTarget === 'directory');
};

/**
 * Check if a file is hidden
 * - Windows: checks the `hidden` attribute (set by localFsBridge)
 * - Unix/Linux (remote): also treats dotfiles (names starting with '.') as hidden
 * The ".." parent directory entry is never considered hidden.
 *
 * @param isLocal  When true, only the Windows hidden attribute is checked.
 *                 This prevents `.gitignore` etc. from disappearing on local Windows panes.
 */
export const isHiddenFile = <T extends { name: string; hidden?: boolean }>(
    file: T,
    isLocal?: boolean
): boolean => {
    if (file.name === "..") return false;
    // Windows hidden attribute — always checked
    if (file.hidden === true) return true;
    // Unix/Linux dotfile convention — only on remote/non-local connections
    if (!isLocal && file.name.startsWith(".")) return true;
    return false;
};

/** @deprecated Use isHiddenFile instead */
export const isWindowsHiddenFile = <T extends { name: string; hidden?: boolean }>(file: T): boolean =>
    isHiddenFile(file, true);

/**
 * Filter files based on hidden file visibility setting.
 * Filters Windows hidden files and, on remote connections, Unix/Linux dotfiles.
 * Always preserves ".." parent directory entry.
 *
 * @param isLocal  Pass true for local filesystem panes to skip dotfile filtering.
 */
export const filterHiddenFiles = <T extends { name: string; hidden?: boolean }>(
    files: T[],
    showHiddenFiles: boolean,
    isLocal?: boolean
): T[] => {
    if (showHiddenFiles) return files;
    return files.filter((f) => !isHiddenFile(f, isLocal));
};
