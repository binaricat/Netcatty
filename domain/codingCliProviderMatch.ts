import { CODING_CLI_PROVIDERS, getCodingCliProvider, type CodingCliProvider, type CodingCliProviderId } from './codingCliProviders';
import {
  inferCodingCliProviderFromTitleSignals,
  titleIncludesPhrase,
} from './codingCliTitleParse';
import type { Host, TerminalSession } from '../types';
import { isDynamicTabTitleDisabled } from './sessionTabTitle';

export type SessionCodingCliSource = Pick<
  TerminalSession,
  | 'dynamicTitle'
  | 'startupCommand'
  | 'customName'
  | 'hostLabel'
  | 'localShell'
  | 'localShellName'
  | 'codingCliProviderId'
> & {
  hostStartupCommand?: Host['startupCommand'];
};

export function getCodingCliCommandBasename(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return '';
  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  const segments = firstToken.split(/[\\/]/);
  const basename = (segments.pop() || '').toLowerCase();
  return basename.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

export function matchCodingCliProviderFromCommand(commandLine: string): CodingCliProvider | undefined {
  const basename = getCodingCliCommandBasename(commandLine);
  if (!basename) return undefined;

  return CODING_CLI_PROVIDERS.find((provider) => (
    provider.command === basename
    || provider.aliases?.some((alias) => alias === basename)
  ));
}

export function matchCodingCliProviderFromTitle(title: string): CodingCliProvider | undefined {
  const inferredId = inferCodingCliProviderFromTitleSignals(title);
  if (inferredId) {
    return getCodingCliProvider(inferredId);
  }

  const normalized = title.toLowerCase();
  if (!normalized.trim()) return undefined;

  const ranked = [...CODING_CLI_PROVIDERS].sort((left, right) => {
    const leftHints = [
      ...(left.titleHints ?? []),
      left.label,
      left.command,
      ...(left.aliases ?? []),
    ];
    const rightHints = [
      ...(right.titleHints ?? []),
      right.label,
      right.command,
      ...(right.aliases ?? []),
    ];
    const leftMax = Math.max(...leftHints.map((hint) => hint.length), 0);
    const rightMax = Math.max(...rightHints.map((hint) => hint.length), 0);
    return rightMax - leftMax;
  });

  for (const provider of ranked) {
    const hints = [
      ...(provider.titleHints ?? []),
      provider.label,
      provider.command,
      ...(provider.aliases ?? []),
    ];
    if (hints.some((hint) => titleIncludesPhrase(normalized, hint))) {
      return provider;
    }
  }

  return undefined;
}

/**
 * Resolve the active coding CLI for a terminal session from launch commands
 * and shell-reported window titles.
 */
export function resolveCodingCliProviderFromCommandCandidates(
  source: Pick<SessionCodingCliSource, 'startupCommand' | 'localShell'>,
  host?: Pick<Host, 'startupCommand'>,
): CodingCliProvider | undefined {
  const commandCandidates = [
    source.startupCommand,
    host?.startupCommand,
    source.localShell,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const commandLine of commandCandidates) {
    const provider = matchCodingCliProviderFromCommand(commandLine);
    if (provider) return provider;
  }

  return undefined;
}

export function resolveSessionCodingCliProvider(
  source: SessionCodingCliSource,
  host?: Pick<Host, 'disableDynamicTabTitle' | 'startupCommand'>,
): CodingCliProvider | undefined {
  if (source.codingCliProviderId) {
    const sticky = getCodingCliProvider(source.codingCliProviderId);
    if (sticky) return sticky;
  }

  const commandProvider = resolveCodingCliProviderFromCommandCandidates(source, host);
  if (commandProvider) return commandProvider;

  if (!isDynamicTabTitleDisabled(host) && !source.customName) {
    const dynamicTitle = source.dynamicTitle?.trim();
    if (dynamicTitle) {
      const provider = matchCodingCliProviderFromTitle(dynamicTitle);
      if (provider) return provider;
    }
  }

  if (source.localShellName) {
    return matchCodingCliProviderFromTitle(source.localShellName);
  }

  return undefined;
}

export function resolveSessionCodingCliProviderId(
  source: SessionCodingCliSource,
  host?: Pick<Host, 'disableDynamicTabTitle' | 'startupCommand'>,
): CodingCliProviderId | undefined {
  return resolveSessionCodingCliProvider(source, host)?.id;
}
