const ARCHIVE_SUFFIXES: Array<{ kind: string; suffixes: string[] }> = [
  { kind: "tar.gz", suffixes: [".tar.gz", ".tgz"] },
  { kind: "tar.bz2", suffixes: [".tar.bz2", ".tbz2", ".tar.bzip2"] },
  { kind: "tar.xz", suffixes: [".tar.xz", ".txz"] },
  { kind: "tar.zst", suffixes: [".tar.zst", ".tzst"] },
  { kind: "tar", suffixes: [".tar"] },
  { kind: "zip", suffixes: [".zip"] },
  { kind: "gz", suffixes: [".gz"] },
  { kind: "bz2", suffixes: [".bz2"] },
  { kind: "xz", suffixes: [".xz"] },
];

function archiveBaseName(fileName: string): string {
  const normalized = String(fileName || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

export function getSftpArchiveKind(fileName: string): string | null {
  const base = archiveBaseName(fileName).toLowerCase();
  if (!base) return null;
  for (const entry of ARCHIVE_SUFFIXES) {
    if (entry.suffixes.some((suffix) => base.endsWith(suffix) && base.length > suffix.length)) {
      return entry.kind;
    }
  }
  return null;
}

export function isExtractableArchive(fileName: string): boolean {
  return getSftpArchiveKind(fileName) != null;
}
