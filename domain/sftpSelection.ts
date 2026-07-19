import type { SftpViewMode } from './sftpTypeahead';

export const resolveSftpActiveSelection = <T>(
  viewMode: SftpViewMode,
  selectedFileNames: string[],
  treeSelection: T[],
): { selectedFileNames: string[]; treeSelection: T[] } => viewMode === 'list'
  ? { selectedFileNames, treeSelection: [] }
  : { selectedFileNames: [], treeSelection };

export const resolveSftpSelectAllTarget = (
  viewMode: SftpViewMode,
  visibleTreeItemCount: number,
): 'list' | 'tree' | 'none' => {
  if (viewMode === 'list') return 'list';
  return visibleTreeItemCount > 0 ? 'tree' : 'none';
};
