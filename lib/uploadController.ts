import type { UploadBridge } from "./uploadService.types";

export class UploadController {
  private cancelled = false;
  private activeFileTransferIds = new Set<string>();
  private activeCompressionIds = new Set<string>();
  private currentTransferId = "";
  private bridge: UploadBridge | null = null;

  /**
   * Cancel all active uploads
   */
  async cancel(): Promise<void> {
    this.cancelled = true;

    // Cancel all active compressed uploads
    const activeCompressionIds = Array.from(this.activeCompressionIds);
    for (const compressionId of activeCompressionIds) {
      try {
        // Import and call cancelCompressedUpload
        const { cancelCompressedUpload } = await import('../infrastructure/services/compressUploadService');
        await cancelCompressedUpload(compressionId);
      } catch {
        // Ignore cancel errors
      }
    }

    // Cancel all active file uploads
    const activeIds = Array.from(this.activeFileTransferIds);
    for (const transferId of activeIds) {
      try {
        // Try cancelTransfer first (for stream transfers)
        if (this.bridge?.cancelTransfer) {
          await this.bridge.cancelTransfer(transferId);
        }
        // Also try cancelSftpUpload (for legacy uploads)
        if (this.bridge?.cancelSftpUpload) {
          await this.bridge.cancelSftpUpload(transferId);
        }
      } catch {
        // Ignore cancel errors
      }
    }

    // Also cancel current one if not in the set
    if (this.currentTransferId && !activeIds.includes(this.currentTransferId)) {
      try {
        if (this.bridge?.cancelTransfer) {
          await this.bridge.cancelTransfer(this.currentTransferId);
        }
        if (this.bridge?.cancelSftpUpload) {
          await this.bridge.cancelSftpUpload(this.currentTransferId);
        }
      } catch {
        // Ignore cancel errors
      }
    }
  }

  /**
   * Check if upload was cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Get all active transfer IDs
   */
  getActiveTransferIds(): string[] {
    const ids = Array.from(this.activeFileTransferIds);
    if (this.currentTransferId && !ids.includes(this.currentTransferId)) {
      ids.push(this.currentTransferId);
    }
    // Also include compression IDs
    const compressionIds = Array.from(this.activeCompressionIds);
    return [...ids, ...compressionIds];
  }

  /**
   * Reset controller state for new upload
   */
  reset(): void {
    this.cancelled = false;
    this.activeFileTransferIds.clear();
    this.activeCompressionIds.clear();
    this.currentTransferId = "";
  }

  /**
   * Set the bridge for cancellation
   */
  setBridge(bridge: UploadBridge): void {
    this.bridge = bridge;
  }

  /**
   * Track a file transfer ID
   */
  addActiveTransfer(id: string): void {
    this.activeFileTransferIds.add(id);
    this.currentTransferId = id;
  }

  /**
   * Remove a tracked file transfer ID
   */
  removeActiveTransfer(id: string): void {
    this.activeFileTransferIds.delete(id);
    if (this.currentTransferId === id) {
      this.currentTransferId = "";
    }
  }

  /**
   * Clear current transfer ID
   */
  clearCurrentTransfer(): void {
    this.currentTransferId = "";
  }

  /**
   * Track a compression ID
   */
  addActiveCompression(id: string): void {
    this.activeCompressionIds.add(id);
  }

  /**
   * Remove a tracked compression ID
   */
  removeActiveCompression(id: string): void {
    this.activeCompressionIds.delete(id);
  }
}
