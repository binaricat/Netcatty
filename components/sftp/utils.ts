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
import type { LucideIcon } from 'lucide-react';
import { SftpFileEntry } from '../../types';

// Pre-built icon maps for O(1) lookup in getFileIcon
type IconDef = [LucideIcon, string?];

const EXTENSION_ICON_MAP = new Map<string, IconDef>([
    // Documents
    ['doc', [FileText, "text-blue-500"]],
    ['docx', [FileText, "text-blue-500"]],
    ['rtf', [FileText, "text-blue-500"]],
    ['odt', [FileText, "text-blue-500"]],
    ['xls', [FileSpreadsheet, "text-green-500"]],
    ['xlsx', [FileSpreadsheet, "text-green-500"]],
    ['csv', [FileSpreadsheet, "text-green-500"]],
    ['ods', [FileSpreadsheet, "text-green-500"]],
    ['ppt', [FileType, "text-orange-500"]],
    ['pptx', [FileType, "text-orange-500"]],
    ['odp', [FileType, "text-orange-500"]],
    ['pdf', [FileText, "text-red-500"]],
    // Code/Scripts
    ['js', [FileCode, "text-yellow-500"]],
    ['jsx', [FileCode, "text-yellow-500"]],
    ['ts', [FileCode, "text-yellow-500"]],
    ['tsx', [FileCode, "text-yellow-500"]],
    ['mjs', [FileCode, "text-yellow-500"]],
    ['cjs', [FileCode, "text-yellow-500"]],
    ['py', [FileCode, "text-blue-400"]],
    ['pyc', [FileCode, "text-blue-400"]],
    ['pyw', [FileCode, "text-blue-400"]],
    ['sh', [Terminal, "text-green-400"]],
    ['bash', [Terminal, "text-green-400"]],
    ['zsh', [Terminal, "text-green-400"]],
    ['fish', [Terminal, "text-green-400"]],
    ['bat', [Terminal, "text-green-400"]],
    ['cmd', [Terminal, "text-green-400"]],
    ['ps1', [Terminal, "text-green-400"]],
    ['c', [FileCode, "text-blue-600"]],
    ['cpp', [FileCode, "text-blue-600"]],
    ['h', [FileCode, "text-blue-600"]],
    ['hpp', [FileCode, "text-blue-600"]],
    ['cc', [FileCode, "text-blue-600"]],
    ['cxx', [FileCode, "text-blue-600"]],
    ['java', [FileCode, "text-orange-600"]],
    ['class', [FileCode, "text-orange-600"]],
    ['jar', [FileCode, "text-orange-600"]],
    ['go', [FileCode, "text-cyan-500"]],
    ['rs', [FileCode, "text-orange-400"]],
    ['rb', [FileCode, "text-red-400"]],
    ['php', [FileCode, "text-purple-500"]],
    ['html', [Globe, "text-orange-500"]],
    ['htm', [Globe, "text-orange-500"]],
    ['xhtml', [Globe, "text-orange-500"]],
    ['css', [FileCode, "text-blue-500"]],
    ['scss', [FileCode, "text-blue-500"]],
    ['sass', [FileCode, "text-blue-500"]],
    ['less', [FileCode, "text-blue-500"]],
    ['vue', [FileCode, "text-green-500"]],
    ['svelte', [FileCode, "text-green-500"]],
    // Config/Data
    ['json', [FileCode, "text-yellow-600"]],
    ['json5', [FileCode, "text-yellow-600"]],
    ['xml', [FileCode, "text-orange-400"]],
    ['xsl', [FileCode, "text-orange-400"]],
    ['xslt', [FileCode, "text-orange-400"]],
    ['yml', [Settings, "text-pink-400"]],
    ['yaml', [Settings, "text-pink-400"]],
    ['toml', [Settings, "text-gray-400"]],
    ['ini', [Settings, "text-gray-400"]],
    ['conf', [Settings, "text-gray-400"]],
    ['cfg', [Settings, "text-gray-400"]],
    ['config', [Settings, "text-gray-400"]],
    ['env', [Lock, "text-yellow-500"]],
    ['sql', [Database, "text-blue-400"]],
    ['sqlite', [Database, "text-blue-400"]],
    ['db', [Database, "text-blue-400"]],
    // Images
    ['jpg', [FileImage, "text-purple-400"]],
    ['jpeg', [FileImage, "text-purple-400"]],
    ['png', [FileImage, "text-purple-400"]],
    ['gif', [FileImage, "text-purple-400"]],
    ['bmp', [FileImage, "text-purple-400"]],
    ['webp', [FileImage, "text-purple-400"]],
    ['svg', [FileImage, "text-purple-400"]],
    ['ico', [FileImage, "text-purple-400"]],
    ['tiff', [FileImage, "text-purple-400"]],
    ['tif', [FileImage, "text-purple-400"]],
    ['heic', [FileImage, "text-purple-400"]],
    ['heif', [FileImage, "text-purple-400"]],
    ['avif', [FileImage, "text-purple-400"]],
    // Videos
    ['mp4', [FileVideo, "text-pink-500"]],
    ['mkv', [FileVideo, "text-pink-500"]],
    ['avi', [FileVideo, "text-pink-500"]],
    ['mov', [FileVideo, "text-pink-500"]],
    ['wmv', [FileVideo, "text-pink-500"]],
    ['flv', [FileVideo, "text-pink-500"]],
    ['webm', [FileVideo, "text-pink-500"]],
    ['m4v', [FileVideo, "text-pink-500"]],
    ['3gp', [FileVideo, "text-pink-500"]],
    ['mpeg', [FileVideo, "text-pink-500"]],
    ['mpg', [FileVideo, "text-pink-500"]],
    // Audio
    ['mp3', [FileAudio, "text-green-400"]],
    ['wav', [FileAudio, "text-green-400"]],
    ['flac', [FileAudio, "text-green-400"]],
    ['aac', [FileAudio, "text-green-400"]],
    ['ogg', [FileAudio, "text-green-400"]],
    ['m4a', [FileAudio, "text-green-400"]],
    ['wma', [FileAudio, "text-green-400"]],
    ['opus', [FileAudio, "text-green-400"]],
    ['aiff', [FileAudio, "text-green-400"]],
    // Archives
    ['zip', [FileArchive, "text-amber-500"]],
    ['rar', [FileArchive, "text-amber-500"]],
    ['7z', [FileArchive, "text-amber-500"]],
    ['tar', [FileArchive, "text-amber-500"]],
    ['gz', [FileArchive, "text-amber-500"]],
    ['bz2', [FileArchive, "text-amber-500"]],
    ['xz', [FileArchive, "text-amber-500"]],
    ['tgz', [FileArchive, "text-amber-500"]],
    ['tbz2', [FileArchive, "text-amber-500"]],
    ['lz', [FileArchive, "text-amber-500"]],
    ['lzma', [FileArchive, "text-amber-500"]],
    ['cab', [FileArchive, "text-amber-500"]],
    ['iso', [FileArchive, "text-amber-500"]],
    ['dmg', [FileArchive, "text-amber-500"]],
    // Executables
    ['exe', [File, "text-red-400"]],
    ['msi', [File, "text-red-400"]],
    ['app', [File, "text-red-400"]],
    ['deb', [File, "text-red-400"]],
    ['rpm', [File, "text-red-400"]],
    ['apk', [File, "text-red-400"]],
    ['ipa', [File, "text-red-400"]],
    ['dll', [File, "text-gray-500"]],
    ['so', [File, "text-gray-500"]],
    ['dylib', [File, "text-gray-500"]],
    // Keys/Certs
    ['pem', [Key, "text-yellow-400"]],
    ['crt', [Key, "text-yellow-400"]],
    ['cer', [Key, "text-yellow-400"]],
    ['key', [Key, "text-yellow-400"]],
    ['pub', [Key, "text-yellow-400"]],
    ['ppk', [Key, "text-yellow-400"]],
    // Text/Markdown
    ['md', [FileText, "text-gray-400"]],
    ['markdown', [FileText, "text-gray-400"]],
    ['mdx', [FileText, "text-gray-400"]],
    ['txt', [FileText, "text-muted-foreground"]],
    ['log', [FileText, "text-muted-foreground"]],
    ['text', [FileText, "text-muted-foreground"]],
]);

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
 * Comprehensive file icon helper - returns JSX element based on file type.
 * Uses pre-built Map for O(1) extension lookup.
 */
export const getFileIcon = (entry: SftpFileEntry): React.ReactElement => {
    if (entry.type === 'directory') return React.createElement(Folder, { size: 14 });

    // For symlink files (not directories), show a special symlink icon
    if (entry.type === 'symlink' && entry.linkTarget !== 'directory') {
        return React.createElement(ExternalLink, { size: 14, className: "text-cyan-500" });
    }

    const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() ?? '' : '';

    const iconDef = EXTENSION_ICON_MAP.get(ext);
    if (iconDef) {
        const [Icon, className] = iconDef;
        return React.createElement(Icon, { size: 14, ...(className ? { className } : {}) });
    }

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

export const buildSftpColumnTemplate = (columnWidths: ColumnWidths): string => {
    return [
        `minmax(140px, ${columnWidths.name}fr)`,
        `minmax(0, ${columnWidths.modified}fr)`,
        `minmax(52px, ${columnWidths.size}fr)`,
        `minmax(64px, ${columnWidths.type}fr)`,
    ].join(' ');
};

export const sortSftpEntries = (
    entries: SftpFileEntry[],
    sortField: SortField,
    sortOrder: SortOrder,
): SftpFileEntry[] => {
    if (!entries.length) return entries;

    const sorted = [...entries].sort((a, b) => {
        if (sortField !== 'type') {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
        }

        let cmp = 0;
        switch (sortField) {
            case 'name':
                cmp = a.name.localeCompare(b.name);
                break;
            case 'size':
                cmp = (a.size || 0) - (b.size || 0);
                break;
            case 'modified':
                cmp = (a.lastModified || 0) - (b.lastModified || 0);
                break;
            case 'type': {
                const extA =
                    a.type === 'directory'
                        ? 'folder'
                        : a.name.split('.').pop()?.toLowerCase() || '';
                const extB =
                    b.type === 'directory'
                        ? 'folder'
                        : b.name.split('.').pop()?.toLowerCase() || '';
                cmp = extA.localeCompare(extB);
                break;
            }
        }
        return sortOrder === 'asc' ? cmp : -cmp;
    });

    return sorted;
};

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
/**
 * A file is considered hidden if:
 * - It has the Windows hidden attribute (`hidden === true`), OR
 * - Its name starts with a dot (Unix/Linux dotfile convention)
 *
 * The ".." parent directory entry is never considered hidden.
 */
export const isHiddenFile = <T extends { name: string; hidden?: boolean }>(
    file: T,
): boolean => {
    if (file.name === "..") return false;
    // Windows hidden attribute
    if (file.hidden === true) return true;
    // Unix/Linux dotfile convention
    if (file.name.startsWith(".")) return true;
    return false;
};

/** @deprecated Use isHiddenFile instead */
export const isWindowsHiddenFile = <T extends { name: string; hidden?: boolean }>(file: T): boolean =>
    isHiddenFile(file);

/**
 * Filter files based on hidden file visibility setting.
 * Filters Windows hidden files and Unix/Linux dotfiles on all connections.
 * Always preserves ".." parent directory entry.
 */
export const filterHiddenFiles = <T extends { name: string; hidden?: boolean }>(
    files: T[],
    showHiddenFiles: boolean,
): T[] => {
    if (showHiddenFiles) return files;
    return files.filter((f) => !isHiddenFile(f));
};
