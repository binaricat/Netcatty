import commandBlocklistTable from '../lib/commandBlocklist.json';

const LEGACY_DEFAULT_PATTERNS = [
  ...commandBlocklistTable.common,
  ...commandBlocklistTable.posixNative,
  ...commandBlocklistTable.posix,
];

/**
 * Add PowerShell defaults only to a complete pre-shell-aware list.
 * If any PowerShell default is already present, the list has been upgraded or
 * customized and is left as saved.
 */
export function migrateLegacyCommandBlocklist(blocklist: string[]): string[] {
  const configured = new Set(blocklist);
  if (!LEGACY_DEFAULT_PATTERNS.every((pattern) => configured.has(pattern))) {
    return blocklist;
  }
  if (commandBlocklistTable.powershell.some((pattern) => configured.has(pattern))) {
    return blocklist;
  }
  return [...blocklist, ...commandBlocklistTable.powershell];
}
