/**
 * SFTP File Utilities
 * Helper functions for file type detection and extension handling
 */

import { netcattyBridge } from "../infrastructure/services/netcattyBridge";

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

/** True when the filename has a real extension (e.g. `foo.txt`), not a dot-only name like `.git`. */
export function hasFileExtension(fileName: string): boolean {
  return fileName.lastIndexOf('.') > 0;
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
 * Get language ID for syntax highlighting
 */
export function getLanguageId(fileName: string): string {
  const path = fileName.replace(/\\/g, '/');
  const baseName = path.slice(path.lastIndexOf('/') + 1);
  const ext = getFileExtension(baseName);
  // Keep generic .conf files as INI. Only infer Nginx with filename/path context.
  if (baseName.toLowerCase() === 'nginx.conf'
    || /(?:^|\/)nginx\/(?:conf\/)?(?:conf\.d|snippets)\/.+\.conf$/i.test(path)
    || /(?:^|\/)nginx\/(?:conf\/)?sites-(?:available|enabled)\/[^/]+$/i.test(path)) {
    return 'nginx';
  }
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
    nginx: 'Nginx',
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
  languageIds.add('nginx');

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
  localPath?: string;
  size?: number;
  relativePath: string;  // Path relative to the root of the drop (e.g., "folder/subfolder/file.txt")
  isDirectory: boolean;
}

/** Local tree row from main-process `listLocalTree`. */
export interface LocalTreeListEntry {
  localPath: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
  lastModified: number;
}

/** Live scan counters while expanding a dropped folder. */
export interface DropScanProgress {
  fileCount: number;
  directoryCount: number;
  entryCount: number;
  /** Optional UI label (e.g. root folder names). */
  label?: string;
}

/**
 * Sync snapshot of a drop. DataTransfer must be read before any await —
 * after that, items/files may be empty.
 */
export interface CapturedDropRoot {
  name: string;
  isDirectory: boolean;
  localPath?: string;
  file?: File | null;
  size?: number;
  /** Folder-picker relative path when the File carries webkitRelativePath */
  relativePath?: string;
  /** webkit entry for Chromium walk fallback when no local path is available */
  fsEntry?: FileSystemEntry;
}

export interface CapturedDropPayload {
  roots: CapturedDropRoot[];
  filesFallback: File[];
}

export interface MaterializeDropOptions {
  listLocalTree?: (
    path: string,
    options?: {
      onProgress?: (progress: DropScanProgress) => void;
      abortSignal?: AbortSignal;
    },
  ) => Promise<LocalTreeListEntry[]>;
  onProgress?: (progress: DropScanProgress) => void;
  /** Cooperative cancel for webkit walks and native listLocalTree. */
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean;
}

export const getDropEntryLocalPath = (entry: DropEntry): string | undefined =>
  entry.localPath ?? (entry.file ? getPathForFile(entry.file) : undefined);

const createDropEntriesFromFiles = (files: FileList | File[]): DropEntry[] => {
  const results: DropEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    results.push({
      file,
      localPath: getPathForFile(file),
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      isDirectory: false,
    });
  }
  return results;
};

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

function joinLocalRelativePath(rootPath: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const parts = normalizedRelative.split("/");
  // relativePath is rooted at the drop root name; local path already points at that root.
  const nested = parts.length > 1 ? parts.slice(1).join("/") : "";
  if (!nested) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  return rootPath + separator + nested.replace(/\//g, separator);
}

/**
 * Process file system entries iteratively (non-recursive) to handle large folders.
 * Prefer reconstructing local paths from the drop root so we can skip per-file
 * `entry.file()` when Electron already exposed the folder path.
 */
export function isDropScanCancelledError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "ERR_DROP_SCAN_CANCELLED" || code === "ERR_LOCAL_TREE_CANCELLED";
}

function throwIfDropScanCancelled(options: {
  abortSignal?: AbortSignal;
  isCancelled?: () => boolean;
}): void {
  if (options.abortSignal?.aborted || options.isCancelled?.()) {
    const error = new Error("Drop scan cancelled");
    (error as Error & { code?: string }).code = "ERR_DROP_SCAN_CANCELLED";
    throw error;
  }
}

async function processEntriesIteratively(
  rootEntries: FileSystemEntry[],
  options: {
    rootPathByName?: Map<string, string>;
    onProgress?: (progress: DropScanProgress) => void;
    abortSignal?: AbortSignal;
    isCancelled?: () => boolean;
  } = {},
): Promise<DropEntry[]> {
  const results: DropEntry[] = [];
  const rootPathByName = options.rootPathByName ?? new Map<string, string>();

  // Index-based queue avoids O(n²) Array.shift on huge trees.
  const queue: Array<{ entry: FileSystemEntry; basePath: string }> = [];
  for (const entry of rootEntries) {
    queue.push({ entry, basePath: "" });
  }

  let queueIndex = 0;
  let processedCount = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const YIELD_INTERVAL = 100;
  const PROGRESS_INTERVAL = 32;

  const reportProgress = (force = false) => {
    if (!options.onProgress) return;
    if (!force && processedCount % PROGRESS_INTERVAL !== 0) return;
    options.onProgress({
      fileCount,
      directoryCount,
      entryCount: fileCount + directoryCount,
    });
  };

  while (queueIndex < queue.length) {
    throwIfDropScanCancelled(options);
    const { entry, basePath } = queue[queueIndex++];
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const rootName = relativePath.split("/")[0] ?? entry.name;
    const rootLocalPath = rootPathByName.get(rootName);

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      if (rootLocalPath) {
        // Native path is enough for stream upload; avoid Chromium File materialization.
        results.push({
          file: null,
          localPath: joinLocalRelativePath(rootLocalPath, relativePath),
          relativePath,
          isDirectory: false,
        });
        fileCount++;
      } else {
        try {
          const file = await entryToFile(fileEntry);
          results.push({
            file,
            relativePath,
            isDirectory: false,
          });
          fileCount++;
        } catch (error) {
          console.warn(`Failed to read file entry: ${entry.name}`, error);
        }
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      results.push({
        file: null,
        localPath: rootLocalPath ? joinLocalRelativePath(rootLocalPath, relativePath) : undefined,
        relativePath,
        isDirectory: true,
      });
      directoryCount++;

      try {
        const reader = dirEntry.createReader();
        const childEntries = await readAllDirectoryEntries(reader);
        for (const childEntry of childEntries) {
          queue.push({ entry: childEntry, basePath: relativePath });
        }
      } catch (error) {
        console.warn(`Failed to read directory: ${entry.name}`, error);
      }
    }

    processedCount++;
    reportProgress();
    if (processedCount % YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  reportProgress(true);
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

/** Build a short label for the scanning task (folder names visible immediately). */
export function formatDropScanLabel(roots: readonly CapturedDropRoot[]): string {
  const names = roots.map((root) => root.name).filter(Boolean);
  if (names.length === 0) return "Scanning files...";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/**
 * Synchronously capture drop roots. Must run during the drop/paste event —
 * before any await — or DataTransfer becomes empty.
 */
export function captureDropPayload(dataTransfer: DataTransfer): CapturedDropPayload {
  const filesFallback: File[] = [];
  const files = dataTransfer.files;
  for (let i = 0; i < files.length; i++) {
    filesFallback.push(files[i]);
  }

  const roots: CapturedDropRoot[] = [];
  const items = dataTransfer.items;

  const relativePathForFile = (file: File): string | undefined => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return relative && relative.length > 0 ? relative : undefined;
  };

  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;

      const entry = item.webkitGetAsEntry();
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : (filesFallback[i] ?? null);
      const localPath = file ? getPathForFile(file) : undefined;
      const relativePath = file ? relativePathForFile(file) : undefined;

      if (entry) {
        roots.push({
          name: entry.name,
          isDirectory: entry.isDirectory,
          localPath,
          file: entry.isFile ? file : null,
          size: file?.size,
          relativePath: entry.isFile ? relativePath : undefined,
          fsEntry: entry,
        });
        continue;
      }

      if (file) {
        roots.push({
          name: file.name,
          isDirectory: false,
          localPath: getPathForFile(file),
          file,
          size: file.size,
          relativePath,
        });
      }
    }
  } else {
    for (const file of filesFallback) {
      roots.push({
        name: file.name,
        isDirectory: false,
        localPath: getPathForFile(file),
        file,
        size: file.size,
        relativePath: relativePathForFile(file),
      });
    }
  }

  return { roots, filesFallback };
}

/** Map main-process local tree rows into upload DropEntry records. */
export function localTreeToDropEntries(tree: readonly LocalTreeListEntry[]): DropEntry[] {
  return tree.map((entry) => {
    if (entry.type === "directory") {
      return {
        file: null,
        localPath: entry.localPath,
        relativePath: entry.relativePath,
        isDirectory: true,
        // Do not use directory metadata size in conflict / compressed totals.
      };
    }
    return {
      file: null,
      localPath: entry.localPath,
      relativePath: entry.relativePath,
      isDirectory: false,
      size: entry.size,
    };
  });
}

function countDropEntries(entries: readonly DropEntry[]): DropScanProgress {
  let fileCount = 0;
  let directoryCount = 0;
  for (const entry of entries) {
    if (entry.isDirectory) directoryCount += 1;
    else fileCount += 1;
  }
  return {
    fileCount,
    directoryCount,
    entryCount: fileCount + directoryCount,
  };
}

/**
 * Expand a captured drop into full DropEntry rows.
 * Prefer Electron `listLocalTree` (native fs) for directory roots with a local
 * path; fall back to Chromium FileSystemEntry walk only when necessary.
 */
export async function materializeDropEntries(
  payload: CapturedDropPayload,
  options: MaterializeDropOptions = {},
): Promise<DropEntry[]> {
  const { listLocalTree, onProgress, abortSignal, isCancelled } = options;
  const results: DropEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;

  const report = (label?: string, forcePartial?: DropScanProgress) => {
    if (!onProgress) return;
    if (forcePartial) {
      onProgress({
        ...forcePartial,
        label,
      });
      return;
    }
    onProgress({
      fileCount,
      directoryCount,
      entryCount: fileCount + directoryCount,
      label,
    });
  };

  const nativeDirectoryRoots: CapturedDropRoot[] = [];
  const webkitDirectoryRoots: CapturedDropRoot[] = [];
  const fileRoots: CapturedDropRoot[] = [];

  for (const root of payload.roots) {
    if (root.isDirectory) {
      if (root.localPath && listLocalTree) {
        nativeDirectoryRoots.push(root);
      } else if (root.fsEntry) {
        webkitDirectoryRoots.push(root);
      } else {
        console.warn(`[SFTP] Skipping directory drop root without path or entry: ${root.name}`);
      }
      continue;
    }
    fileRoots.push(root);
  }

  throwIfDropScanCancelled({ abortSignal, isCancelled });

  // Parallel native walks — one IPC per root folder, much faster than webkit.
  if (nativeDirectoryRoots.length > 0 && listLocalTree) {
    // Cumulative progress across roots: each walk reports its own counts.
    const partialByRoot = new Map<string, DropScanProgress>();
    const emitCombined = (label?: string) => {
      let files = fileCount;
      let dirs = directoryCount;
      for (const partial of partialByRoot.values()) {
        files += partial.fileCount;
        dirs += partial.directoryCount;
      }
      report(label, { fileCount: files, directoryCount: dirs, entryCount: files + dirs });
    };

    // Local controller so a single root failure aborts sibling walks too.
    const siblingAbort = new AbortController();
    const stopSiblingScans = () => {
      try {
        siblingAbort.abort();
      } catch {
        // ignore
      }
    };
    if (abortSignal) {
      if (abortSignal.aborted) stopSiblingScans();
      else abortSignal.addEventListener("abort", stopSiblingScans, { once: true });
    }
    const walkSignal = siblingAbort.signal;
    const walkCancelled = () => (
      walkSignal.aborted || abortSignal?.aborted === true || isCancelled?.() === true
    );

    const walkPromises = nativeDirectoryRoots.map(async (root) => {
      throwIfDropScanCancelled({ abortSignal: walkSignal, isCancelled: walkCancelled });
      const tree = await listLocalTree(root.localPath!, {
        abortSignal: walkSignal,
        onProgress: (partial) => {
          partialByRoot.set(root.localPath!, partial);
          emitCombined(root.name);
        },
      });
      return { root, tree };
    });

    let trees: Array<{ root: CapturedDropRoot; tree: LocalTreeListEntry[] }>;
    try {
      trees = await Promise.all(walkPromises);
    } catch (error) {
      stopSiblingScans();
      // Drain remaining native walks so retry does not pile more I/O on top.
      await Promise.allSettled(walkPromises);
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", stopSiblingScans);
    }

    for (const { root, tree } of trees) {
      const entries = localTreeToDropEntries(tree);
      for (const entry of entries) {
        results.push(entry);
        if (entry.isDirectory) directoryCount += 1;
        else fileCount += 1;
      }
      partialByRoot.delete(root.localPath!);
      report(root.name);
    }
  }

  for (const root of fileRoots) {
    results.push({
      file: root.file ?? null,
      localPath: root.localPath,
      relativePath: root.relativePath || root.name,
      isDirectory: false,
      size: root.size ?? root.file?.size,
    });
    fileCount += 1;
  }
  if (fileRoots.length > 0) {
    report();
  }

  if (webkitDirectoryRoots.length > 0) {
    const rootPathByName = new Map<string, string>();
    for (const root of webkitDirectoryRoots) {
      if (root.localPath) rootPathByName.set(root.name, root.localPath);
    }
    const walked = await processEntriesIteratively(
      webkitDirectoryRoots.map((root) => root.fsEntry!).filter(Boolean),
      {
        rootPathByName,
        abortSignal,
        isCancelled,
        onProgress: (partial) => {
          report(undefined, {
            fileCount: fileCount + partial.fileCount,
            directoryCount: directoryCount + partial.directoryCount,
            entryCount: fileCount + directoryCount + partial.entryCount,
          });
        },
      },
    );

    // Attach reconstructed paths when we only know the root path.
    for (const entry of walked) {
      if (!entry.localPath) {
        const rootName = entry.relativePath.split("/")[0];
        const rootPath = rootPathByName.get(rootName);
        if (rootPath) {
          entry.localPath = joinLocalRelativePath(rootPath, entry.relativePath);
        } else if (entry.file) {
          entry.localPath = getPathForFile(entry.file);
        }
      }
      results.push(entry);
      if (entry.isDirectory) directoryCount += 1;
      else fileCount += 1;
    }
    report();
  }

  if (results.length === 0 && payload.filesFallback.length > 0) {
    const fallback = createDropEntriesFromFiles(payload.filesFallback);
    const counts = countDropEntries(fallback);
    report(undefined, counts);
    return fallback;
  }

  report(undefined, { fileCount, directoryCount, entryCount: fileCount + directoryCount });
  return results;
}

/**
 * Extract all files and directories from a DataTransfer object.
 * Supports both regular files and folders dropped from the OS.
 *
 * Prefer Electron native tree walk when local paths are available; otherwise
 * use webkitGetAsEntry with a path-reconstruction fast path.
 */
export async function extractDropEntries(
  dataTransfer: DataTransfer,
  options: MaterializeDropOptions = {},
): Promise<DropEntry[]> {
  const payload = captureDropPayload(dataTransfer);
  const bridge = netcattyBridge.get();
  return materializeDropEntries(payload, {
    listLocalTree: options.listLocalTree
      ?? (bridge?.listLocalTree
        ? (path, treeOptions) => bridge.listLocalTree!(path, treeOptions)
        : undefined),
    onProgress: options.onProgress,
    abortSignal: options.abortSignal,
    isCancelled: options.isCancelled,
  });
}
