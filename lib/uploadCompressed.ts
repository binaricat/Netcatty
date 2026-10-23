import type { DropEntry } from "./sftpFileUtils";
import { getDropEntryLocalPath } from "./sftpFileUtils";

const getDropEntrySize = (entry: DropEntry): number => entry.file?.size ?? entry.size ?? 0;
import type { UploadCallbacks, UploadResult } from "./uploadService.types";
import type { UploadController } from "./uploadController";

const formatUploadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWindowsPlatform = (): boolean =>
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

export async function uploadFoldersCompressed(
  folderEntries: Array<[string, DropEntry[]]>,
  targetPath: string,
  sftpId: string,
  callbacks?: UploadCallbacks,
  controller?: UploadController
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  
  // Import the compressed upload service
  const { startCompressedUpload, checkCompressedUploadSupport } = await import('../infrastructure/services/compressUploadService');
  
  for (const [folderName, entries] of folderEntries) {
    if (controller?.isCancelled()) {
      break;
    }

    // Prefer any file-like entry with a resolvable local path (native tree scans
    // set localPath without a browser File handle).
    const firstFile = entries.find((entry) => (
      !entry.isDirectory && (!!entry.file || !!getDropEntryLocalPath(entry))
    ));
    if (!firstFile) {
      // Empty folder - mark for fallback to regular upload which will create the directory
      results.push({ fileName: folderName, success: false, error: "Compressed upload not supported - fallback needed" });
      continue;
    }

    const localFilePath = getDropEntryLocalPath(firstFile);
    if (!localFilePath) {
      results.push({ fileName: folderName, success: false, error: "Could not get local file path" });
      continue;
    }

    // Extract folder path from the first file path
    // Use DropEntry.relativePath which works for both file input and drag-drop scenarios
    // For file input: webkitRelativePath is set (e.g., "folder/subdir/file.txt")
    // For drag-drop: DropEntry.relativePath contains the correct path from extractDropEntries
    const relativePath = firstFile.relativePath
      || (firstFile.file as (File & { webkitRelativePath?: string }) | null)?.webkitRelativePath
      || firstFile.file?.name
      || folderName;
    
    // Normalize path separators for cross-platform compatibility
    const normalizePathSeparators = (path: string) => path.replace(/\\/g, '/');
    const normalizedLocalPath = normalizePathSeparators(localFilePath);
    const normalizedRelativePath = normalizePathSeparators(relativePath);
    
    // Calculate the root folder path by removing the full relativePath from localFilePath
    // For example: if localFilePath is "/Users/rice/Downloads/110-temp/insideServer/subdir/file.txt"
    // and relativePath is "insideServer/subdir/file.txt", we want "/Users/rice/Downloads/110-temp/insideServer"
    let folderPath = localFilePath;
    if (normalizedRelativePath && normalizedLocalPath.endsWith(normalizedRelativePath)) {
      // Remove the relativePath from the end to get the base directory
      const basePath = localFilePath.substring(0, localFilePath.length - relativePath.length);
      // Remove trailing slash/backslash if present
      const cleanBasePath = basePath.replace(/[/\\]$/, '');
      // Add the folder name to get the actual folder path
      folderPath = cleanBasePath + (cleanBasePath ? (localFilePath.includes('\\') ? '\\' : '/') : '') + folderName;
    } else {
      // Fallback: try to extract based on folder name with normalized separators
      const normalizedFolderPattern1 = '/' + folderName + '/';
      const normalizedFolderPattern2 = '\\' + folderName + '\\';
      const folderIndex1 = normalizedLocalPath.lastIndexOf(normalizedFolderPattern1);
      const folderIndex2 = localFilePath.lastIndexOf(normalizedFolderPattern2);
      const folderIndex = Math.max(folderIndex1, folderIndex2);
      
      if (folderIndex >= 0) {
        folderPath = localFilePath.substring(0, folderIndex + folderName.length + 1);
      } else {
        // Last resort: remove just the filename (original logic)
        const pathParts = normalizedRelativePath.split('/');
        if (pathParts.length > 1) {
          const fileName = pathParts[pathParts.length - 1];
          if (normalizedLocalPath.endsWith(fileName)) {
            folderPath = localFilePath.substring(0, localFilePath.length - fileName.length - 1);
          }
        } else {
          // Single file, get its parent directory
          const lastSlash = Math.max(localFilePath.lastIndexOf('/'), localFilePath.lastIndexOf('\\'));
          if (lastSlash > 0) {
            folderPath = localFilePath.substring(0, lastSlash);
          }
        }
      }
    }

    // Windows tar.exe converts argv to the ANSI code page, so a non-ASCII
    // folder name would be mangled. Upload such folders file by file instead.
    if (isWindowsPlatform() && /[\u0080-\uffff]/.test(folderName)) {
      results.push({ fileName: folderName, success: false, error: "Compressed upload not supported - fallback needed" });
      continue;
    }

    let taskId: string | null = null; // Declare taskId outside try block for error handling

    try {
      // Check if compressed upload is supported
      const support = await checkCompressedUploadSupport(sftpId);
      if (!support.supported) {
        // Fall back to regular upload for this folder
        results.push({
          fileName: folderName,
          success: false,
          error: "Compressed upload not supported - fallback needed"
        });
        continue;
      }
      
      const compressionId = crypto.randomUUID();
      
      // Check for cancellation before starting
      if (controller?.isCancelled()) {
        results.push({ fileName: folderName, success: false, cancelled: true });
        break;
      }
      
      // Register compression ID with controller for cancellation support
      controller?.addActiveCompression(compressionId);
      
      // Create a task for this folder compression
      // Path-only drop entries (listLocalTree) carry size without a File handle.
      const fileEntries = entries.filter((entry) => !entry.isDirectory);
      const totalBytes = fileEntries.reduce((sum, entry) => sum + getDropEntrySize(entry), 0);
      taskId = compressionId;
      
      if (callbacks?.onTaskCreated) {
        callbacks.onTaskCreated({
          id: taskId,
          fileName: folderName,
          displayName: `${folderName} (compressed)`,
          isDirectory: true,
          progressMode: 'bytes',
          totalBytes,
          transferredBytes: 0,
          speed: 0,
          fileCount: fileEntries.length,
          completedCount: 0,
          sourcePath: folderPath,
          controlKind: 'compressed-upload',
        });
      }
      
      // Start compressed upload
      const result = await startCompressedUpload(
        {
          compressionId,
          folderPath,
          targetPath,
          sftpId,
          folderName,
          totalBytes,
        },
      );
      controller?.removeActiveCompression(compressionId);
      
      if (result.success) {
        results.push({ fileName: folderName, success: true });
      } else if (result.error?.includes('cancelled') || controller?.isCancelled()) {
        // Handle cancellation
        results.push({ fileName: folderName, success: false, cancelled: true });
      } else {
        results.push({ fileName: folderName, success: false, error: result.error });
      }
      
    } catch (error) {
      const errorMessage = formatUploadError(error);
      
      // Remove compression ID from controller on error
      if (taskId) {
        controller?.removeActiveCompression(taskId);
      }
      
      // Check if this was a cancellation
      if (controller?.isCancelled() || errorMessage.includes('cancelled')) {
        results.push({ fileName: folderName, success: false, cancelled: true });
      } else {
        results.push({ fileName: folderName, success: false, error: errorMessage });
      }
    }
  }
  
  return results;
}
