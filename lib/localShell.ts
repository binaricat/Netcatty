export type LocalShellType = 'posix' | 'fish' | 'powershell' | 'cmd' | 'unknown';
export type LocalOs = 'linux' | 'macos' | 'windows';

const POWERSHELL_SHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const CMD_SHELLS = new Set(['cmd', 'cmd.exe']);
const FISH_SHELLS = new Set(['fish']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);

const getExecutableBaseName = (filePath: string | undefined): string => {
  const normalized = String(filePath || '').trim();
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/);
  return (parts[parts.length - 1] || '').toLowerCase();
};

export const detectLocalOs = (platformLike?: string): LocalOs => {
  const platform = String(platformLike || '').toLowerCase();
  if (platform.includes('mac') || platform.includes('darwin')) return 'macos';
  if (platform.includes('win')) return 'windows';
  return 'linux';
};

export const classifyLocalShellType = (
  shellPath: string | undefined,
  platformLike?: string,
): LocalShellType => {
  const shellName = getExecutableBaseName(shellPath);
  if (POWERSHELL_SHELLS.has(shellName)) return 'powershell';
  if (CMD_SHELLS.has(shellName)) return 'cmd';
  if (FISH_SHELLS.has(shellName)) return 'fish';
  if (POSIX_SHELLS.has(shellName)) return 'posix';
  if (!shellName) {
    return detectLocalOs(platformLike) === 'windows' ? 'powershell' : 'posix';
  }
  return 'unknown';
};
