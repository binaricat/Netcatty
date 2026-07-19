import type { SftpViewMode } from '../../../domain/sftpTypeahead';

const paneViewModes = new Map<string, SftpViewMode>();

export const sftpPaneViewModeStore = {
  get: (paneId: string): SftpViewMode => paneViewModes.get(paneId) ?? 'list',
  set: (paneId: string, viewMode: SftpViewMode) => {
    paneViewModes.set(paneId, viewMode);
  },
  clear: (paneId: string) => {
    paneViewModes.delete(paneId);
  },
};
