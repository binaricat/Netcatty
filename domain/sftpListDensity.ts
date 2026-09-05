export const SFTP_LIST_DENSITIES = ["comfortable", "compact"] as const;

export type SftpListDensity = (typeof SFTP_LIST_DENSITIES)[number];

export const DEFAULT_SFTP_LIST_DENSITY: SftpListDensity = "comfortable";

export function parseSftpListDensity(value: unknown): SftpListDensity {
  return value === "compact" ? "compact" : DEFAULT_SFTP_LIST_DENSITY;
}

export function getNextSftpListDensity(density: SftpListDensity): SftpListDensity {
  return density === "compact" ? "comfortable" : "compact";
}

export function getSftpListDensityToggleLabelKey(density: SftpListDensity): string {
  return density === "compact"
    ? "sftp.listDensity.switchToComfortable"
    : "sftp.listDensity.switchToCompact";
}

export function sftpFileRowDensityClass(density: SftpListDensity): string {
  return density === "compact" ? "px-3 py-0.5 text-xs" : "px-4 py-2 text-sm";
}

export function sftpFileRowIconDensityClass(density: SftpListDensity): string {
  return density === "compact" ? "h-5 w-5" : "h-7 w-7";
}
