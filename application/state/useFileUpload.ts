/**
 * useFileUpload - Handle file paste/drop with base64 conversion
 *
 * Supports images, PDFs, and other document types.
 * Ported from 1code's use-agents-file-upload.ts
 */
import { useCallback, useState } from 'react';
import { getPathForFile } from '../../lib/sftpFileUtils';

export interface UploadedFile {
  id: string;
  filename: string;
  dataUrl: string;      // data:...;base64,... for preview
  base64Data: string;   // raw base64 for API
  mediaType: string;    // MIME type e.g. "image/png", "application/pdf"
  filePath?: string;    // original filesystem path (Electron only)
}

/** Reject only known binary blobs that AI models can't process */
const REJECTED_MIME_PREFIXES = ['video/', 'audio/'];

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

export function useFileUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

  const addFiles = useCallback(async (inputFiles: File[]) => {
    const supported = inputFiles.filter(isSupportedFile);
    if (supported.length === 0) return;

    const newFiles: UploadedFile[] = await Promise.all(
      supported.map(async (file) => {
        const id = crypto.randomUUID();
        const filename = file.name || `file-${Date.now()}`;
        const mediaType = file.type || 'application/octet-stream';
        let dataUrl = '';
        let base64Data = '';
        try {
          const result = await fileToDataUrl(file);
          dataUrl = result.dataUrl;
          base64Data = result.base64;
        } catch (err) {
          console.error('[useFileUpload] Failed to convert:', err);
        }
        const filePath = getPathForFile(file);
        return { id, filename, dataUrl, base64Data, mediaType, filePath };
      }),
    );

    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
  }, []);

  return { files, addFiles, removeFile, clearFiles };
}
