/**
 * File upload conversion helpers for AI draft attachments.
 *
 * Supports images, PDFs, and other document types.
 * Ported from 1code's use-agents-file-upload.ts
 */
import type { UploadedFile } from '../../infrastructure/ai/types';
import { getPathForFile } from '../../lib/sftpFileUtils';

export type { UploadedFile } from '../../infrastructure/ai/types';

/** Reject only known binary blobs that AI models can't process */
const REJECTED_MIME_PREFIXES = ['video/', 'audio/'];

/**
 * Infer MIME type from file extension when the browser/Electron doesn't
 * provide one (common for .yaml, .sh, .toml, and other code/text files).
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  // Code & Scripts
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  scala: 'text/x-scala',
  php: 'text/x-php',
  pl: 'text/x-perl',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  fish: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  bat: 'text/x-batch',
  cmd: 'text/x-batch',
  sql: 'text/x-sql',
  r: 'text/x-r',
  lua: 'text/x-lua',
  dart: 'text/x-dart',
  // Web
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  // Config / Data
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  json: 'application/json',
  jsonc: 'application/json',
  jsonl: 'application/jsonl',
  xml: 'application/xml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  // Docs
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  tex: 'text/x-tex',
  rst: 'text/x-rst',
  log: 'text/plain',
  // Other typed files
  pdf: 'application/pdf',
  dockerfile: 'text/x-dockerfile',
};

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return fileName.toLowerCase(); // e.g. "Dockerfile", "Makefile"
  return fileName.slice(dot + 1).toLowerCase();
}

function inferMediaType(fileName: string, fileType: string): string {
  if (fileType) return fileType;
  const ext = getExtension(fileName);
  return EXTENSION_MIME_TYPES[ext] || 'application/octet-stream';
}

function isSupportedFile(file: File): boolean {
  // Allow files with empty MIME (common in Electron for .sh, .yaml, etc.)
  if (!file.type) return true;
  return !REJECTED_MIME_PREFIXES.some(prefix => file.type.startsWith(prefix));
}

async function fileToDataUrl(file: File): Promise<{ dataUrl: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      resolve({ dataUrl, base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function convertFilesToUploads(inputFiles: File[]): Promise<UploadedFile[]> {
  const supported = inputFiles.filter(isSupportedFile);
  if (supported.length === 0) return [];

  const uploads: Array<UploadedFile | null> = await Promise.all(
    supported.map(async (file) => {
      const id = crypto.randomUUID();
      const filename = file.name || `file-${Date.now()}`;
      const mediaType = inferMediaType(filename, file.type);
      try {
        const result = await fileToDataUrl(file);
        const filePath = getPathForFile(file);
        return {
          id,
          filename,
          dataUrl: result.dataUrl,
          base64Data: result.base64,
          mediaType,
          filePath,
        };
      } catch (err) {
        console.error('[useFileUpload] Failed to convert:', err);
        return null;
      }
    }),
  );

  return uploads.filter((upload): upload is UploadedFile => upload !== null);
}
