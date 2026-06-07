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
  // Code & Scripts — all use text/plain for maximum provider compatibility
  js: 'text/plain',
  mjs: 'text/plain',
  cjs: 'text/plain',
  jsx: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  rs: 'text/plain',
  go: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  swift: 'text/plain',
  kt: 'text/plain',
  scala: 'text/plain',
  php: 'text/plain',
  pl: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  zsh: 'text/plain',
  fish: 'text/plain',
  ps1: 'text/plain',
  bat: 'text/plain',
  cmd: 'text/plain',
  sql: 'text/plain',
  r: 'text/plain',
  lua: 'text/plain',
  dart: 'text/plain',
  // Web
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/plain',
  sass: 'text/plain',
  less: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  // Config / Data
  yaml: 'text/plain',
  yml: 'text/plain',
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
  dockerfile: 'text/plain',
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
