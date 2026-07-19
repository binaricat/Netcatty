export interface SftpTypeaheadState {
  query: string;
  lastInputAt: number;
}

export interface SftpTypeaheadResult {
  state: SftpTypeaheadState;
  matchIndex: number;
}

const SFTP_TYPEAHEAD_RESET_MS = 1000;

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
