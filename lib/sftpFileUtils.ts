/**
 * SFTP File Utilities
 * Helper functions for file type detection and extension handling
 */

import { netcattyBridge } from "../infrastructure/services/netcattyBridge";

// Common text file extensions
const TEXT_EXTENSIONS = new Set([
  // Code/Scripts
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyw', 'pyi',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1',
  'c', 'cpp', 'h', 'hpp', 'cc', 'cxx', 'hh', 'hxx',
  'java', 'scala', 'kt', 'kts', 'groovy', 'gradle',
  'go', 'rs', 'rb', 'php', 'pl', 'pm', 'lua', 'r', 'R',
  'swift', 'dart', 'cs', 'fs', 'vb',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'cljc',
  'hs', 'lhs', 'elm', 'ml', 'mli', 'nim',
  // Web
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  // Config/Data
  'json', 'json5', 'jsonc', 'xml', 'xsl', 'xslt', 'xsd',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'config', 'properties',
  'env', 'gitignore', 'gitattributes', 'editorconfig', 'eslintrc', 'prettierrc',
  'sql', 'graphql', 'gql',
  // Text/Docs
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rst', 'adoc', 'asciidoc',
  'tex', 'latex', 'bib',
  // Data formats
  'csv', 'tsv', 'psv',
  // System
  'rc', 'bashrc', 'zshrc', 'profile', 'vimrc', 'tmux', 'nanorc',
  'dockerfile', 'containerfile', 'makefile', 'cmake', 'mak',
  // Version control & Git
  'gitconfig', 'gitmodules', 'gitkeep',
  // Other common text formats
  'diff', 'patch', 'htaccess', 'lock', 'sum',
  // Service/System files
  'service', 'socket', 'timer', 'mount', 'automount', 'target',
  // Shell history and data
  'history', 'zsh_history', 'bash_history',
]);

// Additional filenames (no extension) that are always text
const TEXT_FILENAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'authors', 'contributors',
  'copying', 'install', 'news', 'todo', 'history', 'makefile', 'dockerfile',
  'gemfile', 'rakefile', 'brewfile', 'procfile', 'vagrantfile',
  'cmakelists.txt', 'cmakelists',
]);

// Common image file extensions
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg',
  'ico', 'tiff', 'tif', 'heic', 'heif', 'avif', 'jfif',
]);

// Known binary file extensions - files that should never be opened as text
const BINARY_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'tif',
  'heic', 'heif', 'avif', 'jfif', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef',
  // Audio
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'aiff', 'opus',
  // Video
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpeg', 'mpg',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz', 'lzma', 'zst',
  'tgz', 'tbz2', 'txz', 'cab', 'iso', 'dmg',
  // Executables
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'deb', 'rpm',
  'apk', 'ipa', 'jar', 'war', 'ear',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  // Object files
  'o', 'obj', 'pyc', 'pyo', 'class', 'beam',
  // Other binary
  'swf', 'fla', 'blend', 'unity3d', 'unitypackage',
]);

// MIME types for images (for creating blob URLs)
const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

// Language IDs for syntax highlighting
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  bat: 'batch',
  cmd: 'batch',
  ps1: 'powershell',
  psm1: 'powershell',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  R: 'r',
  swift: 'swift',
  dart: 'dart',
  cs: 'csharp',
  fs: 'fsharp',
  vb: 'vb',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  xml: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  txt: 'plaintext',
  log: 'plaintext',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  diff: 'diff',
  patch: 'diff',
};

/**
 * Get the file extension from a filename
 * For files without extension, returns 'file'
 */
export function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) {
    return 'file'; // No extension or hidden file without extension
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}

/**
 * Check if a file is a text file based on its extension and name
 */
export function isTextFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);

  // Check known text extensions
  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  // Check common filenames that are text but have no extension
  const baseName = fileName.toLowerCase().split('/').pop() || '';
  const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');

  // Check exact filename matches
  if (TEXT_FILENAMES.has(baseName) || TEXT_FILENAMES.has(nameWithoutExt)) {
    return true;
  }

  // Check dot-files that are typically text config files
  if (baseName.startsWith('.')) {
    const dotConfigPatterns = [
      /^\.(git|npm|yarn|docker|eslint|prettier|babel|env)/,
      /^\.(nvmrc|ruby-version|python-version|node-version)$/,
      /rc$/, // Files ending with 'rc' like .bashrc, .vimrc
    ];
    if (dotConfigPatterns.some(pattern => pattern.test(baseName))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if binary data appears to be text by analyzing byte patterns
 * This provides a more accurate detection than extension-only checking
 * 
 * @param data - First chunk of file data (ArrayBuffer or Uint8Array)
 * @param maxBytes - Maximum bytes to check (default 512)
 * @returns true if data appears to be text
 */
export function isTextData(data: ArrayBuffer | Uint8Array, maxBytes: number = 512): boolean {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const checkLength = Math.min(bytes.length, maxBytes);

  if (checkLength === 0) return true; // Empty file is considered text

  let controlChars = 0;
  let nullBytes = 0;
  let highBytes = 0;
  let totalBytes = 0;

  for (let i = 0; i < checkLength; i++) {
    const byte = bytes[i];
    totalBytes++;

    // Null bytes are strong indicators of binary files
    if (byte === 0) {
      nullBytes++;
      if (nullBytes > 0) return false; // Even one null byte suggests binary
    }

    // Control characters (except common ones like \t, \n, \r)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      controlChars++;
    }

    // High-bit characters (non-ASCII) - some are OK for UTF-8
    if (byte > 127) {
      highBytes++;
    }
  }

  // If more than 30% are control chars or more than 95% are high-bit chars, likely binary
  const controlRatio = controlChars / totalBytes;
  const highRatio = highBytes / totalBytes;

  if (controlRatio > 0.3) return false;
  if (highRatio > 0.95) return false;

  return true;
}

/**
 * Enhanced text file detection combining extension and content analysis
 * Use this when you have access to file data for better accuracy
 */
export function isTextFileEnhanced(fileName: string, data?: ArrayBuffer | Uint8Array): boolean {
  // First check by extension
  const extCheck = isTextFile(fileName);

  // If we have data, verify it's actually text
  if (data && data.byteLength > 0) {
    return extCheck && isTextData(data);
  }

  // Fall back to extension-only check
  return extCheck;
}

/**
 * Check if a file is definitely a binary file based on its extension.
 * Used to exclude files from "Edit" option in context menu.
 */
export function isKnownBinaryFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Check if a file could potentially be opened as text.
 * This is more permissive than isTextFile - it returns true for any file
 * that is not a known binary file. Used for showing "Edit" in context menu.
 * Actual text detection should be done by reading file content.
 */
export function couldBeTextFile(fileName: string): boolean {
  // If it's a known binary file, definitely not text
  if (isKnownBinaryFile(fileName)) {
    return false;
  }
  // Otherwise, it could be text - we'll verify when actually opening
  return true;
}

/**
 * Check if a file is an image file based on its extension
 */
export function isImageFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get MIME type for an image file
 */
export function getImageMimeType(fileName: string): string {
  const ext = getFileExtension(fileName);
  return IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Get language ID for syntax highlighting
 */
export function getLanguageId(fileName: string): string {
  const ext = getFileExtension(fileName);
  return EXTENSION_TO_LANGUAGE[ext] || 'plaintext';
}

/**
 * Get a user-friendly name for a language
 */
export function getLanguageName(languageId: string): string {
  const names: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    shell: 'Shell',
    batch: 'Batch',
    powershell: 'PowerShell',
    c: 'C',
    cpp: 'C++',
    java: 'Java',
    kotlin: 'Kotlin',
    go: 'Go',
    rust: 'Rust',
    ruby: 'Ruby',
    php: 'PHP',
    perl: 'Perl',
    lua: 'Lua',
    r: 'R',
    swift: 'Swift',
    dart: 'Dart',
    csharp: 'C#',
    fsharp: 'F#',
    vb: 'Visual Basic',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    json: 'JSON',
    jsonc: 'JSON with Comments',
    json5: 'JSON5',
    xml: 'XML',
    yaml: 'YAML',
    toml: 'TOML',
    ini: 'INI',
    sql: 'SQL',
    graphql: 'GraphQL',
    markdown: 'Markdown',
    plaintext: 'Plain Text',
    vue: 'Vue',
    svelte: 'Svelte',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    diff: 'Diff',
  };
  return names[languageId] || languageId.charAt(0).toUpperCase() + languageId.slice(1);
}

/**
 * File opener application types
 * - 'builtin-editor': Built-in text editor (Monaco)
 * - 'system-app': External system application (stores path)
 */
export type FileOpenerType = 'builtin-editor' | 'system-app';

/**
 * System application info for file associations
 */
export interface SystemAppInfo {
  path: string;  // Path to the executable/app
  name: string;  // Display name
}

/**
 * File association record
 */
export interface FileAssociation {
  extension: string;
  openerType: FileOpenerType;
  systemApp?: SystemAppInfo;  // Only set when openerType is 'system-app'
}

/**
 * Get all supported language IDs for syntax highlighting dropdown
 */
export function getSupportedLanguages(): { id: string; name: string }[] {
  const languageIds = new Set(Object.values(EXTENSION_TO_LANGUAGE));
  languageIds.add('plaintext');

  return Array.from(languageIds)
    .map(id => ({ id, name: getLanguageName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Represents a file or directory entry from drag-and-drop
 * This includes the relative path for nested files in folders
 */
export interface DropEntry {
  file: File | null;  // null for directory entries
  relativePath: string;  // Path relative to the root of the drop (e.g., "folder/subfolder/file.txt")
  isDirectory: boolean;
}

/**
 * Convert a FileSystemEntry to a File
 */
function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/**
 * Read all entries from a directory reader
 * Handles the fact that readEntries may not return all entries at once
 */
async function readAllDirectoryEntries(
  directoryReader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  const allEntries: FileSystemEntry[] = [];

  // Keep reading until we get an empty result
  let entries: FileSystemEntry[];
  do {
    entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      directoryReader.readEntries(resolve, reject);
    });
    for (const entry of entries) {
      allEntries.push(entry);
    }
  } while (entries.length > 0);

  return allEntries;
}

/**
 * Process file system entries iteratively (non-recursive) to handle large folders
 * Uses a queue-based approach to avoid stack overflow
 * @param rootEntries - The root entries to process
 * @returns Array of DropEntry objects with files and their relative paths
 */
async function processEntriesIteratively(
  rootEntries: FileSystemEntry[]
): Promise<DropEntry[]> {
  const results: DropEntry[] = [];

  // Queue of entries to process: [entry, basePath]
  const queue: Array<{ entry: FileSystemEntry; basePath: string }> = [];

  // Initialize queue with root entries
  for (const entry of rootEntries) {
    queue.push({ entry, basePath: "" });
  }

  let processedCount = 0;
  const YIELD_INTERVAL = 100; // Yield to main thread every N items

  while (queue.length > 0) {
    const { entry, basePath } = queue.shift()!;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      try {
        const file = await entryToFile(fileEntry);
        results.push({
          file,
          relativePath: basePath ? `${basePath}/${entry.name}` : entry.name,
          isDirectory: false,
        });
      } catch (error) {
        console.warn(`Failed to read file entry: ${entry.name}`, error);
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const currentPath = basePath ? `${basePath}/${entry.name}` : entry.name;

      // Add directory entry
      results.push({
        file: null,
        relativePath: currentPath,
        isDirectory: true,
      });

      try {
        const reader = dirEntry.createReader();
        const childEntries = await readAllDirectoryEntries(reader);

        // Add child entries to the queue (not recursive!)
        for (const childEntry of childEntries) {
          queue.push({ entry: childEntry, basePath: currentPath });
        }
      } catch (error) {
        console.warn(`Failed to read directory: ${entry.name}`, error);
      }
    }

    // Yield to main thread periodically to keep UI responsive
    processedCount++;
    if (processedCount % YIELD_INTERVAL === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  return results;
}

/**
 * Get the local file path for a File object using Electron's webUtils API
 * Falls back to the legacy file.path property if webUtils is not available
 */
export function getPathForFile(file: File): string | undefined {
  try {
    // Try Electron's webUtils API (exposed via preload)
    const path = netcattyBridge.get()?.getPathForFile?.(file);
    if (path) return path;
    // Fallback: try legacy file.path property
    return (file as File & { path?: string }).path;
  } catch {
    return undefined;
  }
}

/**
 * Extract all files and directories from a DataTransfer object
 * Supports both regular files and folders dropped from the OS
 *
 * Uses the webkitGetAsEntry() API for folder access, with fallback
 * to regular FileList for browsers that don't support it.
 *
 * @param dataTransfer - The DataTransfer object from a drop event
 * @returns Array of DropEntry objects with files and relative paths
 */
export async function extractDropEntries(
  dataTransfer: DataTransfer
): Promise<DropEntry[]> {
  const items = dataTransfer.items;

  // Build a map of file/folder name to path from the original files in DataTransfer.files
  const filePathMap = new Map<string, string>();
  const filesWithPath = dataTransfer.files;
  for (let i = 0; i < filesWithPath.length; i++) {
    const f = filesWithPath[i];
    const path = getPathForFile(f);
    if (path) {
      filePathMap.set(f.name, path);
    }
  }

  // Check if webkitGetAsEntry is supported (for folder access)
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    // Collect all entries first (getAsEntry must be called synchronously)
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
        }
      }
    }

    // Process entries iteratively (non-recursive) to avoid stack overflow
    const results = await processEntriesIteratively(entries);

    // Restore the 'path' property for all files
    // Try to get the path directly from webUtils.getPathForFile for each file
    // This is more reliable than trying to reconstruct from folder paths
    for (const result of results) {
      if (result.file) {
        // First try to get path directly from the file
        const directPath = getPathForFile(result.file);
        if (directPath) {
          (result.file as File & { path?: string }).path = directPath;
        } else {
          // Fallback: try to reconstruct from root folder path
          const pathParts = result.relativePath.split('/');
          const rootName = pathParts[0];
          const rootPath = filePathMap.get(rootName);

          if (rootPath) {
            if (pathParts.length === 1) {
              // Root-level file: use the path directly
              (result.file as File & { path?: string }).path = rootPath;
            } else {
              // Nested file in a folder: construct full path
              // rootPath is the path to the root folder, we need to append the rest
              const restOfPath = pathParts.slice(1).join('/');
              const separator = rootPath.includes('\\') ? '\\' : '/';
              const fullPath = rootPath + separator + restOfPath.replace(/\//g, separator);
              (result.file as File & { path?: string }).path = fullPath;
            }
          }
        }
      }
    }

    return results;
  } else {
    // Fallback: use regular FileList (no folder support)
    // Files from FileList in Electron already have the 'path' property
    const results: DropEntry[] = [];
    const files = dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      results.push({
        file,
        relativePath: file.name,
        isDirectory: false,
      });
    }
    return results;
  }
}
