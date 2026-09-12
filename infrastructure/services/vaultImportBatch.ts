import type { Host } from "../../domain/models";
import {
  buildVaultHostMergeKey,
  importVaultHostsFromText,
  mergeVaultImportIssues,
  type VaultImportFormat,
  type VaultImportIssue,
  type VaultImportResult,
} from "../../domain/vaultImport";
import {
  readVaultImportFile,
  type VaultImportFileEncoding,
} from "./vaultImportFile";

export interface VaultImportBatchProgress {
  completedFiles: number;
  totalFiles: number;
  fileName: string;
}

interface ImportVaultHostFilesOptions {
  format: VaultImportFormat;
  files: File[];
  relativePaths?: string[];
  encoding?: VaultImportFileEncoding;
  masterPassword?: string;
  onProgress?: (progress: VaultImportBatchProgress) => void;
}

const SECURE_CRT_METADATA_FILES = new Set([
  "__folderdata__.ini",
  "default.ini",
]);

const normalizeRelativePath = (file: File, transferredRelativePath?: string): string[] => {
  const relativePath = transferredRelativePath?.trim() || file.webkitRelativePath?.trim();
  if (!relativePath) return [file.name];
  return relativePath.split(/[\\/]+/).filter(Boolean);
};

const secureCrtGroupFromFile = (
  file: File,
  transferredRelativePath?: string,
): string | undefined => {
  const segments = normalizeRelativePath(file, transferredRelativePath);
  if (segments.length <= 1) return undefined;

  segments.pop();
  const selectedRoot = segments.shift();
  if (
    selectedRoot?.toLowerCase() !== "sessions"
    && segments[0]?.toLowerCase() === "sessions"
  ) {
    segments.shift();
  }
  return segments.length > 0 ? segments.join("/") : undefined;
};

const shouldIgnoreSecureCrtFile = (file: File): boolean => (
  SECURE_CRT_METADATA_FILES.has(file.name.toLowerCase())
  || !file.name.toLowerCase().endsWith(".ini")
);

export async function importVaultHostFiles({
  format,
  files,
  relativePaths,
  encoding,
  masterPassword,
  onProgress,
}: ImportVaultHostFilesOptions): Promise<VaultImportResult> {
  const sourceFiles = files.map((file, index) => ({
    file,
    relativePath: relativePaths?.[index],
  }));
  const selectedFiles = format === "securecrt"
    ? sourceFiles.filter(({ file }) => !shouldIgnoreSecureCrtFile(file))
    : sourceFiles.slice(0, 1);
  const hosts: Host[] = [];
  const issues: VaultImportIssue[] = [];
  const keyPassphrases: NonNullable<VaultImportResult["keyPassphrases"]> = [];
  const keyPassphraseCandidates: NonNullable<VaultImportResult["keyPassphraseCandidates"]> = [];
  let parsed = 0;
  let skipped = 0;
  let duplicates = 0;

  for (let index = 0; index < selectedFiles.length; index++) {
    const { file, relativePath } = selectedFiles[index];
    try {
      const text = await readVaultImportFile(format, file, encoding);
      const result = importVaultHostsFromText(format, text, {
        fileName: file.name,
        masterPassword,
      });
      const group = format === "securecrt"
        ? secureCrtGroupFromFile(file, relativePath)
        : undefined;
      const fileHosts = result.hosts.map((host) => (
        group && !host.group ? { ...host, group } : host
      ));

      parsed += result.stats.parsed;
      skipped += result.stats.skipped;
      duplicates += result.stats.duplicates;
      issues.push(...result.issues.map((issue) => ({
        ...issue,
        message: `${file.name}: ${issue.message}`,
      })));
      keyPassphrases.push(...(result.keyPassphrases ?? []));
      keyPassphraseCandidates.push(...(result.keyPassphraseCandidates ?? []));

      if (fileHosts.length === 0) {
        if (result.stats.skipped === 0 && result.issues.length === 0) {
          skipped++;
          issues.push({
            level: "warning",
            message: `${file.name}: no importable SecureCRT session found.`,
          });
        }
      } else {
        hosts.push(...fileHosts);
      }
    } catch (error) {
      if (format !== "securecrt" || selectedFiles.length <= 1) throw error;
      skipped++;
      issues.push({
        level: "error",
        message: `${file.name}: ${error instanceof Error ? error.message : "Unable to read file."}`,
      });
    } finally {
      onProgress?.({
        completedFiles: index + 1,
        totalFiles: selectedFiles.length,
        fileName: file.name,
      });
    }
  }

  const seen = new Set<string>();
  const uniqueHosts = format === "securecrt"
    ? hosts
    : hosts.filter((host) => {
      const key = buildVaultHostMergeKey(host);
      if (seen.has(key)) {
        duplicates++;
        return false;
      }
      seen.add(key);
      return true;
    });
  const groups = Array.from(new Set(
    uniqueHosts.map((host) => host.group).filter((group): group is string => Boolean(group)),
  ));

  return {
    hosts: uniqueHosts,
    groups,
    issues: mergeVaultImportIssues(issues),
    stats: {
      parsed,
      imported: uniqueHosts.length,
      skipped,
      duplicates,
    },
    ...(keyPassphrases.length > 0 ? { keyPassphrases } : {}),
    ...(keyPassphraseCandidates.length > 0 ? { keyPassphraseCandidates } : {}),
  };
}
