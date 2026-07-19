export interface SftpTypeaheadState {
  query: string;
  lastInputAt: number;
}

export interface SftpTypeaheadResult {
  state: SftpTypeaheadState;
  matchIndex: number;
}

export type SftpViewMode = 'list' | 'tree';

interface SftpTypeaheadTreeItem {
  name: string;
  path: string;
}

export type SftpTypeaheadSource =
  | { kind: 'list'; names: string[] }
  | { kind: 'tree'; names: string[]; items: SftpTypeaheadTreeItem[] };

const SFTP_TYPEAHEAD_RESET_MS = 1000;

export const resolveSftpTypeaheadSource = (
  viewMode: SftpViewMode,
  listItems: string[],
  treeItems: SftpTypeaheadTreeItem[],
): SftpTypeaheadSource => viewMode === 'list'
  ? { kind: 'list', names: listItems }
  : { kind: 'tree', names: treeItems.map((item) => item.name), items: treeItems };

export const advanceSftpTypeahead = (
  names: string[],
  previous: SftpTypeaheadState | null,
  key: string,
  now: number,
): SftpTypeaheadResult => {
  const continuesPrevious = previous && now - previous.lastInputAt <= SFTP_TYPEAHEAD_RESET_MS;
  const query = `${continuesPrevious ? previous.query : ''}${key}`.toLocaleLowerCase();

  return {
    state: { query, lastInputAt: now },
    matchIndex: names.findIndex((name) => name.toLocaleLowerCase().startsWith(query)),
  };
};
