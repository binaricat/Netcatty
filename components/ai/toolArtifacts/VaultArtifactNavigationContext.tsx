import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { Host, Snippet, VaultNote } from '../../../types';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { toast } from '../../ui/toast';
import type { VaultSummarySection, VaultToolArtifact } from './vaultToolArtifact';

export type VaultArtifactNavSection = Extract<VaultSummarySection, 'notes' | 'hosts' | 'snippets'>;

export interface VaultArtifactNavigationActions {
  openVaultNote?: (noteId: string) => void;
  openVaultHost?: (hostId: string) => void;
  openVaultSnippet?: (snippetId: string) => void;
  openVaultSection?: (section: VaultArtifactNavSection) => void;
}

interface CreateVaultArtifactNavigationActionsOptions {
  notes: VaultNote[];
  hosts: Host[];
  snippets: Snippet[];
  t: (key: string) => string;
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSnippet?: (snippetId: string) => void;
  onOpenVaultSection?: (section: VaultArtifactNavSection) => void;
  onUnavailable: (message: string, title: string) => void;
}

interface VaultArtifactNavigationProviderProps {
  notes: VaultNote[];
  hosts: Host[];
  snippets?: Snippet[];
  onOpenVaultNote?: (noteId: string) => void;
  onOpenVaultHost?: (hostId: string) => void;
  onOpenVaultSnippet?: (snippetId: string) => void;
  onOpenVaultSection?: (section: VaultArtifactNavSection) => void;
  children: React.ReactNode;
}

const VaultArtifactNavigationContext = createContext<VaultArtifactNavigationActions | null>(null);

export function createVaultArtifactNavigationActions({
  notes,
  hosts,
  snippets,
  t,
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSnippet,
  onOpenVaultSection,
  onUnavailable,
}: CreateVaultArtifactNavigationActionsOptions): VaultArtifactNavigationActions {
  const actions: VaultArtifactNavigationActions = {};

  if (onOpenVaultNote) {
    actions.openVaultNote = (noteId: string) => {
      const exists = notes.some((note) => note.id === noteId);
      if (!exists) {
        onUnavailable(t('ai.chat.artifact.noteMissing'), t('ai.chat.artifact.unavailableTitle'));
        return;
      }
      onOpenVaultNote(noteId);
    };
  }

  if (onOpenVaultHost) {
    actions.openVaultHost = (hostId: string) => {
      const exists = hosts.some((host) => host.id === hostId);
      if (!exists) {
        onUnavailable(t('ai.chat.artifact.hostMissing'), t('ai.chat.artifact.unavailableTitle'));
        return;
      }
      onOpenVaultHost(hostId);
    };
  }

  if (onOpenVaultSnippet) {
    actions.openVaultSnippet = (snippetId: string) => {
      const exists = snippets.some((snippet) => snippet.id === snippetId);
      if (!exists) {
        onUnavailable(t('ai.chat.artifact.snippetMissing'), t('ai.chat.artifact.unavailableTitle'));
        return;
      }
      onOpenVaultSnippet(snippetId);
    };
  }

  if (onOpenVaultSection) {
    actions.openVaultSection = onOpenVaultSection;
  }

  return actions;
}

export function VaultArtifactNavigationProvider({
  notes,
  hosts,
  snippets = [],
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSnippet,
  onOpenVaultSection,
  children,
}: VaultArtifactNavigationProviderProps) {
  const { t } = useI18n();

  const onUnavailable = useCallback((message: string, title: string) => {
    toast.warning(message, title);
  }, []);

  const value = useMemo<VaultArtifactNavigationActions>(() => createVaultArtifactNavigationActions({
    notes,
    hosts,
    snippets,
    t,
    onOpenVaultNote,
    onOpenVaultHost,
    onOpenVaultSnippet,
    onOpenVaultSection,
    onUnavailable,
  }), [
    hosts,
    notes,
    onOpenVaultHost,
    onOpenVaultNote,
    onOpenVaultSection,
    onOpenVaultSnippet,
    onUnavailable,
    snippets,
    t,
  ]);

  return (
    <VaultArtifactNavigationContext.Provider value={value}>
      {children}
    </VaultArtifactNavigationContext.Provider>
  );
}

export function useVaultArtifactNavigation(): VaultArtifactNavigationActions | null {
  return useContext(VaultArtifactNavigationContext);
}

export function navigateVaultArtifact(
  artifact: VaultToolArtifact,
  navigation: VaultArtifactNavigationActions,
): void {
  switch (artifact.kind) {
    case 'vault.note':
      navigation.openVaultNote?.(artifact.noteId);
      break;
    case 'vault.host':
      navigation.openVaultHost?.(artifact.hostId);
      break;
    case 'vault.hosts.batch':
      navigation.openVaultSection?.('hosts');
      break;
    case 'vault.summary':
      if (artifact.section === 'scripts') {
        navigation.openVaultSection?.('snippets');
      } else {
        navigation.openVaultSection?.(artifact.section);
      }
      break;
    case 'vault.snippet':
    case 'vault.script':
      navigation.openVaultSnippet?.(artifact.kind === 'vault.snippet' ? artifact.snippetId : artifact.scriptId);
      break;
    case 'vault.snippet.run':
      navigation.openVaultSnippet?.(artifact.snippetId);
      break;
    case 'vault.script.run':
      navigation.openVaultSnippet?.(artifact.scriptId);
      break;
    case 'vault.script.reference':
    case 'vault.script.runs':
      navigation.openVaultSection?.('snippets');
      break;
    default:
      break;
  }
}

export function canNavigateVaultArtifact(
  artifact: VaultToolArtifact,
  navigation: VaultArtifactNavigationActions | null,
): boolean {
  if (!navigation) return false;
  switch (artifact.kind) {
    case 'vault.note':
      return Boolean(navigation.openVaultNote);
    case 'vault.host':
      return Boolean(navigation.openVaultHost);
    case 'vault.hosts.batch':
    case 'vault.summary':
    case 'vault.script.reference':
    case 'vault.script.runs':
      return Boolean(navigation.openVaultSection);
    case 'vault.snippet':
    case 'vault.script':
    case 'vault.snippet.run':
    case 'vault.script.run':
      return Boolean(navigation.openVaultSnippet);
    default:
      return false;
  }
}
