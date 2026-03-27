/**
 * Lightweight store that tracks the sorted display file names per SFTP pane.
 * Used by keyboard shortcuts to navigate with ArrowUp/ArrowDown in list view.
 */

const paneItems = new Map<string, string[]>();

export const sftpListOrderStore = {
  /** Update the ordered list of file names for a pane (call from SftpPaneFileList). */
  setItems: (paneId: string, names: string[]) => {
    paneItems.set(paneId, names);
  },

  /** Get the ordered list of file names (excluding "..") for arrow key navigation. */
  getItems: (paneId: string): string[] => paneItems.get(paneId) ?? [],

  clearPane: (paneId: string) => {
    paneItems.delete(paneId);
  },
};
