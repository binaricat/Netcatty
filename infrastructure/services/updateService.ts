/**
 * Update Service
 *
 * Combines two update mechanisms:
 * 1. GitHub API-based version comparison (used by useUpdateCheck for notification banner)
 * 2. electron-updater bridge (used by SettingsSystemTab for download/install)
 */

import { netcattyBridge } from "./netcattyBridge";

// ================================
// Part 1: GitHub API Version Check
// ================================

const GITHUB_API_URL = 'https://api.github.com/repos/binaricat/Netcatty/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/binaricat/Netcatty/releases';

export interface ReleaseInfo {
  version: string;       // e.g. "1.0.0" (without 'v' prefix)
  tagName: string;       // e.g. "v1.0.0"
  name: string;          // Release title
  body: string;          // Release notes (markdown)
  htmlUrl: string;       // URL to the release page
  publishedAt: string;   // ISO date string
  assets: ReleaseAsset[];
}

export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestRelease: ReleaseInfo | null;
  error?: string;
}

/**
 * Parse version string to comparable array
 * e.g. "1.2.3" -> [1, 2, 3]
 */
function parseVersion(version: string): number[] {
  // Remove 'v' prefix if present
  const clean = version.replace(/^v/i, '');
  return clean.split('.').map((part) => {
    const num = parseInt(part, 10);
    return isNaN(num) ? 0 : num;
  });
}

/**
 * Compare two version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Check for updates via GitHub API (compares version strings).
 * Used by useUpdateCheck for the notification banner.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const data = await response.json();
    const latestVersion = (data.tag_name as string).replace(/^v/i, '');

    const latestRelease: ReleaseInfo = {
      version: latestVersion,
      tagName: data.tag_name,
      name: data.name || data.tag_name,
      body: data.body || '',
      htmlUrl: data.html_url,
      publishedAt: data.published_at,
      assets: (data.assets || []).map((a: { name: string; browser_download_url: string; size: number }) => ({
        name: a.name,
        browserDownloadUrl: a.browser_download_url,
        size: a.size,
      })),
    };

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return { hasUpdate, currentVersion, latestRelease };
  } catch (error) {
    return {
      hasUpdate: false,
      currentVersion,
      latestRelease: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get release page URL for a specific version
 */
export function getReleaseUrl(version?: string): string {
  if (version) {
    return `${RELEASES_PAGE_URL}/tag/v${version.replace(/^v/i, '')}`;
  }
  return RELEASES_PAGE_URL;
}

/**
 * Get download URL for current platform
 */
export function getDownloadUrlForPlatform(
  release: ReleaseInfo,
  platform: string
): string | null {
  const assets = release.assets;

  // Platform-specific file patterns
  const patterns: Record<string, RegExp[]> = {
    win32: [/\.exe$/i, /win.*\.zip$/i, /windows/i],
    darwin: [/\.dmg$/i, /mac.*\.zip$/i, /darwin/i],
    linux: [/\.AppImage$/i, /\.deb$/i, /linux/i],
  };

  const platformPatterns = patterns[platform] || [];

  for (const pattern of platformPatterns) {
    const asset = assets.find((a) => pattern.test(a.name));
    if (asset) {
      return asset.browserDownloadUrl;
    }
  }

  // Fallback to release page
  return null;
}

// =============================================
// Part 2: electron-updater Bridge (IPC-based)
// =============================================

export interface ElectronUpdateCheckResult {
  available: boolean;
  supported?: boolean;
  version?: string;
  releaseNotes?: string;
  releaseDate?: string | null;
  error?: string;
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export async function checkForUpdate(): Promise<ElectronUpdateCheckResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.checkForUpdate) {
    return { available: false, supported: false, error: "Bridge unavailable" };
  }
  try {
    return await bridge.checkForUpdate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { available: false, error: message };
  }
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
  const bridge = netcattyBridge.get();
  if (!bridge?.downloadUpdate) {
    return { success: false, error: "Bridge unavailable" };
  }
  return bridge.downloadUpdate();
}

export function installUpdate(): void {
  const bridge = netcattyBridge.get();
  bridge?.installUpdate?.();
}

export function onDownloadProgress(
  cb: (progress: UpdateDownloadProgress) => void,
): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateDownloadProgress?.(cb);
}

export function onDownloaded(cb: () => void): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateDownloaded?.(cb);
}

export function onError(
  cb: (payload: { error: string }) => void,
): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateError?.(cb);
}

/** Returns the GitHub Releases page URL, optionally for a specific version tag. */
export function getReleasesUrl(version?: string): string {
  if (version) {
    return `${RELEASES_PAGE_URL}/tag/v${version}`;
  }
  return `${RELEASES_PAGE_URL}/latest`;
}
