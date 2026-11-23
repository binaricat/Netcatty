/**
 * Update Service
 *
 * GitHub API-based version comparison used by useUpdateCheck for the notification banner.
 */

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
