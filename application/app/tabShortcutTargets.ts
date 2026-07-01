/** Tab ids targeted by keyboard tab navigation shortcuts. */
export function buildNumberShortcutTabTargets(params: {
  showSftpTab: boolean;
  shellOnlyTabNumberShortcuts: boolean;
  orderedTabs: readonly string[];
  editorTabIds: readonly string[];
}): string[] {
  const workTabs = [...params.orderedTabs, ...params.editorTabIds];
  if (params.shellOnlyTabNumberShortcuts) {
    return workTabs;
  }
  const pinnedTabs = params.showSftpTab ? ['vault', 'sftp'] : ['vault'];
  return [...pinnedTabs, ...workTabs];
}
