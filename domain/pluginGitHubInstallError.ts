// Host errors cross Electron IPC as messages. Keep their presentation local to
// this flow; never use translated strings to make authorization decisions.
export function describePluginGitHubInstallError(message: string) {
  const rules: [RegExp, string][] = [
    [/^Use https:\/\/github\.com\/owner\/repo,/, 'invalidRepository'],
    [/^GitHub plugin installation unavailable$/, 'unavailable'],
    [/^Download and review a GitHub plugin first$/, 'reviewFirst'],
    [/^Cannot reach GitHub\./, 'network'],
    [/^GitHub download timed out$/, 'timeout'],
    [/^GitHub API rate limit reached\./, 'rateLimit'],
    [/^GitHub repository or asset not found\./, 'notFound'],
    [/^GitHub access denied\./, 'accessDenied'],
    [/^GitHub repository moved\./, 'moved'],
    [/^(GitHub download redirect|Too many GitHub download redirects)/, 'redirect'],
    [/^(This repository has no published stable release|Publish a stable GitHub release)/, 'noRelease'],
    [/^Release has no \.ncpkg asset\./, 'noAsset'],
    [/^Release contains multiple \.ncpkg assets\./, 'multipleAssets'],
    [/^(Invalid GitHub plugin artifact|GitHub release asset has no valid download URL|GitHub returned invalid release metadata)/, 'metadata'],
    [/^(GitHub did not return the selected public repository|GitHub asset does not belong|Invalid GitHub release identity)/, 'identity'],
    [/^The release tag has no accessible commit\./, 'commit'],
    [/^(GitHub download exceeds size limit|GitHub package size is invalid)/, 'size'],
    [/^GitHub package (size|SHA-256) mismatch$/, 'integrity'],
    [/^(Expected a \.ncpkg ZIP package|GitHub returned HTML\/XML|GitHub download has no body)/, 'package'],
    [/^A GitHub plugin operation is already active/, 'busy'],
    [/^GitHub package preview expired\./, 'expired'],
    [/^This package requires advanced developer mode/, 'advanced'],
    [/^Plugin is incompatible:/, 'incompatible'],
    [/^Plugin source differs\./, 'source'],
  ];
  // invoke() may prepend its own channel/error wrapper to the original message.
  const original = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const status = /^GitHub download failed \(HTTP (\d{3})\)$/.exec(original)?.[1];
  const kind = status ? 'http' : rules.find(([pattern]) => pattern.test(original))?.[1] ?? 'failed';
  return {
    key: `settings.plugins.github.error.${kind}`,
    values: { status },
    // Keep validator/compatibility diagnostics available without making the
    // primary error an untranslated host exception.
    details: kind === 'failed' || kind === 'incompatible' ? message : null,
  };
}
