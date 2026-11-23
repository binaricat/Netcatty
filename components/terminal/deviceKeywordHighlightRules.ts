import type { Host } from '../../types';
import type { AdditionalTerminalKeywordHighlightRule } from './terminalKeywordHighlightRules';

/**
 * Console protocols that always drive a network device: serial/eNSPro are raw
 * device consoles by definition, and Telnet in this app is used for switch and
 * router CLIs rather than interactive Unix shells.
 */
const ALWAYS_DEVICE_CONSOLE_PROTOCOLS: ReadonlySet<string> = new Set(['serial', 'ensp', 'telnet']);

const EMPTY_RULES: readonly AdditionalTerminalKeywordHighlightRule[] = Object.freeze([]);

/**
 * Built-in highlights for switch/router console output. The global defaults
 * cover syslog-ish words ("error", "ok") and IP/MAC addresses, which misses
 * the vocabulary that actually matters on a device: link state, CLI rejections,
 * the paging prompt and the prompt line itself.
 *
 * Rules are matched case-insensitively in declaration order (first hit wins),
 * so more specific entries come first.
 */
export const DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES: readonly AdditionalTerminalKeywordHighlightRule[] =
  Object.freeze([
    {
      id: 'device-admin-down',
      label: 'Administratively down',
      patterns: ['\\badministratively down\\b'],
      color: '#FB923C',
      enabled: true,
    },
    {
      id: 'device-cli-reject',
      label: 'CLI rejection',
      patterns: [
        '^\\s*%\\s*(?:invalid|error|incomplete|unrecognized|ambiguous|too many|permission denied)\\b.*$',
        '^\\s*(?:error|invalid input)\\b.*$',
      ],
      color: '#F87171',
      enabled: true,
    },
    {
      id: 'device-link-down',
      label: 'Link down',
      patterns: ['\\bdown\\b'],
      color: '#F87171',
      enabled: true,
    },
    {
      id: 'device-link-up',
      label: 'Link up',
      patterns: ['\\bup\\b'],
      color: '#34D399',
      enabled: true,
    },
    {
      id: 'device-paging',
      label: 'Paging prompt',
      patterns: ['-{2,}\\s*more\\s*-{2,}'],
      color: '#FBBF24',
      enabled: true,
    },
    {
      id: 'device-prompt',
      label: 'Device prompt',
      patterns: [
        '^\\s*<[^<>\\r\\n]{1,64}>\\s*$',
        '^\\s*\\[[^\\[\\]\\r\\n]{1,64}\\]\\s*$',
        '^\\s*[A-Za-z$][\\w.\\-]*(?:\\([^)]*\\))?[>#]\\s*$',
      ],
      color: '#22D3EE',
      enabled: true,
    },
    {
      id: 'device-command',
      label: 'Typed command',
      // Everything after a device prompt on the same line: the CLI echoes the
      // command back, so this is the line the operator just typed.
      patterns: [
        '(?<=^\\s*(?:<[^<>\\r\\n]{1,64}>|\\[[^\\[\\]\\r\\n]{1,64}\\]|[A-Za-z$][\\w.\\-]*(?:\\([^)]*\\))?[>#]))\\s*\\S[^\\r\\n]*$',
      ],
      color: '#C4B5FD',
      enabled: true,
    },
  ] as const);

export function isDeviceConsoleHost(
  host?: Pick<Host, 'protocol' | 'deviceType'> | null,
): boolean {
  if (!host) return false;
  if (host.deviceType === 'network') return true;
  return ALWAYS_DEVICE_CONSOLE_PROTOCOLS.has(String(host.protocol));
}

export function resolveDeviceConsoleKeywordHighlightRules(
  host?: Pick<Host, 'protocol' | 'deviceType'> | null,
  enabled = true,
): readonly AdditionalTerminalKeywordHighlightRule[] {
  if (!enabled) return EMPTY_RULES;
  return isDeviceConsoleHost(host) ? DEVICE_CONSOLE_KEYWORD_HIGHLIGHT_RULES : EMPTY_RULES;
}
