import {
  AlertCircle,
  FilePenLine,
  FileText,
  FolderInput,
  LayoutGrid,
  Library,
  NotebookPen,
  Server,
  ServerCog,
} from 'lucide-react';
import React from 'react';
import { cn } from '../../../lib/utils';
import type { VaultToolArtifact } from './vaultToolArtifact';

export type VaultArtifactVisualKind =
  | 'noteCreate'
  | 'noteUpdate'
  | 'noteRead'
  | 'noteList'
  | 'host'
  | 'hostCreate'
  | 'hostImport'
  | 'hostList'
  | 'error';

const ARTIFACT_ICON_SIZE = 18;

const VISUAL_STYLES: Record<VaultArtifactVisualKind, { wrapper: string; icon: string }> = {
  noteCreate: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
  noteUpdate: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/90' },
  noteRead: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/80' },
  noteList: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  host: { wrapper: 'bg-emerald-500/12', icon: 'text-emerald-400' },
  hostCreate: { wrapper: 'bg-sky-500/12', icon: 'text-sky-400' },
  hostImport: { wrapper: 'bg-amber-500/12', icon: 'text-amber-400' },
  hostList: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  error: { wrapper: 'bg-destructive/10', icon: 'text-destructive/80' },
};

export function resolveVaultArtifactVisualKind(
  artifact: VaultToolArtifact,
  toolName?: string,
): VaultArtifactVisualKind {
  if (artifact.kind === 'error') return 'error';

  if (artifact.kind === 'vault.note') {
    if (toolName === 'vault_notes_create') return 'noteCreate';
    if (toolName === 'vault_notes_update') return 'noteUpdate';
    return 'noteRead';
  }

  if (artifact.kind === 'vault.host') return 'host';

  if (artifact.kind === 'vault.hosts.batch') {
    if (artifact.sourceTool === 'vault_hosts_import' || toolName === 'vault_hosts_import') {
      return 'hostImport';
    }
    return 'hostCreate';
  }

  if (artifact.kind === 'vault.summary') {
    return artifact.section === 'notes' ? 'noteList' : 'hostList';
  }

  return 'host';
}

function renderVisualIcon(kind: VaultArtifactVisualKind): React.ReactNode {
  const className = VISUAL_STYLES[kind].icon;
  switch (kind) {
    case 'noteCreate':
      return <NotebookPen size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'noteUpdate':
      return <FilePenLine size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'noteRead':
      return <FileText size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'noteList':
      return <Library size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'host':
      return <Server size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'hostCreate':
      return <ServerCog size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'hostImport':
      return <FolderInput size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'hostList':
      return <LayoutGrid size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'error':
      return <AlertCircle size={ARTIFACT_ICON_SIZE} className={className} />;
    default:
      return <Server size={ARTIFACT_ICON_SIZE} className={className} />;
  }
}

export function VaultArtifactIcon({
  artifact,
  toolName,
}: {
  artifact: VaultToolArtifact;
  toolName?: string;
}) {
  const kind = resolveVaultArtifactVisualKind(artifact, toolName);
  const styles = VISUAL_STYLES[kind];

  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
        styles.wrapper,
      )}
    >
      {renderVisualIcon(kind)}
    </span>
  );
}
