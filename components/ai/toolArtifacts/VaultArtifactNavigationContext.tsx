import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { Host, VaultNote } from '../../../types';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { toast } from '../../ui/toast';
import type { VaultToolArtifact } from './vaultToolArtifact';

export interface VaultArtifactNavigationActions {
  openVaultNote: (noteId: string) => void;
  openVaultHost: (hostId: string) => void;
  openVaultSection: (section: 'notes' | 'hosts') => void;
}

interface VaultArtifactNavigationProviderProps {
  notes: VaultNote[];
  hosts: Host[];
  onOpenVaultNote: (noteId: string) => void;
  onOpenVaultHost: (hostId: string) => void;
  onOpenVaultSection: (section: 'notes' | 'hosts') => void;
  children: React.ReactNode;
}

const VaultArtifactNavigationContext = createContext<VaultArtifactNavigationActions | null>(null);

export function VaultArtifactNavigationProvider({
  notes,
  hosts,
  onOpenVaultNote,
  onOpenVaultHost,
  onOpenVaultSection,
  children,
}: VaultArtifactNavigationProviderProps) {
  const { t } = useI18n();

  const openVaultNote = useCallback((noteId: string) => {
    const exists = notes.some((note) => note.id === noteId);
    if (!exists) {
      toast.warning(t('ai.chat.artifact.noteMissing'), t('ai.chat.artifact.unavailableTitle'));
      return;
    }
    onOpenVaultNote(noteId);
  }, [notes, onOpenVaultNote, t]);

  const openVaultHost = useCallback((hostId: string) => {
    const exists = hosts.some((host) => host.id === hostId);
    if (!exists) {
      toast.warning(t('ai.chat.artifact.hostMissing'), t('ai.chat.artifact.unavailableTitle'));
      return;
    }
    onOpenVaultHost(hostId);
  }, [hosts, onOpenVaultHost, t]);

  const value = useMemo<VaultArtifactNavigationActions>(() => ({
    openVaultNote,
    openVaultHost,
    openVaultSection: onOpenVaultSection,
  }), [onOpenVaultHost, onOpenVaultNote, onOpenVaultSection, openVaultHost, openVaultNote]);

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
      navigation.openVaultNote(artifact.noteId);
      break;
    case 'vault.host':
      navigation.openVaultHost(artifact.hostId);
      break;
    case 'vault.hosts.batch':
      navigation.openVaultSection('hosts');
      break;
    case 'vault.summary':
      navigation.openVaultSection(artifact.section);
      break;
    default:
      break;
  }
}
