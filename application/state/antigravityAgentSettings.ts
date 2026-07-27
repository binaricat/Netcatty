import type { ExternalAgentConfig } from '../../infrastructure/ai/types';
import { encryptField } from '../../infrastructure/persistence/secureFieldAdapter';

export async function encryptAntigravityApiKey(
  apiKey: string,
  encrypt: (value: string) => Promise<string> = encryptField,
): Promise<string | undefined> {
  const trimmed = apiKey.trim();
  return trimmed ? encrypt(trimmed) : undefined;
}

export function updateAntigravityAgentCredential(
  agents: ExternalAgentConfig[],
  options: {
    encryptedApiKey?: string;
    resolvedPath?: string | null;
    currentPath?: string | null;
    customPath?: string;
    available: boolean;
  },
): ExternalAgentConfig[] {
  const existing = agents.find((agent) => agent.id === 'discovered_antigravity');
  if (!options.encryptedApiKey && !existing) return agents;

  const customPath = String(options.customPath || '').trim();
  const command = options.resolvedPath
    || existing?.command
    || options.currentPath
    || customPath
    || 'python3';
  const nextAgent: ExternalAgentConfig = {
    ...(existing ?? {
      id: 'discovered_antigravity',
      name: 'Google Antigravity',
      args: [],
      icon: 'gemini',
      sdkBackend: 'antigravity',
      enabled: true,
    }),
    apiKey: options.encryptedApiKey,
    command,
    commandSource: customPath ? 'manual' : 'auto',
    available: options.available,
  };
  return [
    ...agents.filter((agent) => agent.id !== 'discovered_antigravity'),
    nextAgent,
  ];
}
