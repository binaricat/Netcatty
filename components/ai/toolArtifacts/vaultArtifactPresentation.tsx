import {
  AlertCircle,
  BookOpen,
  FileCode,
  FilePenLine,
  FileText,
  FolderInput,
  LayoutGrid,
  Library,
  ListChecks,
  NotebookPen,
  Pause,
  Play,
  Server,
  ServerCog,
  SquareTerminal,
  Trash2,
  Zap,
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
  | 'snippet'
  | 'snippetCreate'
  | 'snippetUpdate'
  | 'snippetList'
  | 'snippetRun'
  | 'snippetDeleted'
  | 'script'
  | 'scriptCreate'
  | 'scriptUpdate'
  | 'scriptList'
  | 'scriptRun'
  | 'scriptDeleted'
  | 'scriptRuns'
  | 'scriptAction'
  | 'scriptReference'
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
  snippet: { wrapper: 'bg-sky-500/12', icon: 'text-sky-400' },
  snippetCreate: { wrapper: 'bg-sky-500/12', icon: 'text-sky-400' },
  snippetUpdate: { wrapper: 'bg-sky-500/10', icon: 'text-sky-300/90' },
  snippetList: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  snippetRun: { wrapper: 'bg-sky-500/10', icon: 'text-sky-300/90' },
  snippetDeleted: { wrapper: 'bg-muted/25', icon: 'text-muted-foreground/60' },
  script: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
  scriptCreate: { wrapper: 'bg-violet-500/12', icon: 'text-violet-400' },
  scriptUpdate: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/90' },
  scriptList: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  scriptRun: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/90' },
  scriptDeleted: { wrapper: 'bg-muted/25', icon: 'text-muted-foreground/60' },
  scriptRuns: { wrapper: 'bg-muted/30', icon: 'text-muted-foreground/70' },
  scriptAction: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/90' },
  scriptReference: { wrapper: 'bg-violet-500/10', icon: 'text-violet-300/90' },
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
    if (artifact.section === 'notes') return 'noteList';
    if (artifact.section === 'hosts') return 'hostList';
    if (artifact.section === 'snippets') return 'snippetList';
    return 'scriptList';
  }

  if (artifact.kind === 'vault.snippet') {
    if (toolName === 'snippets_create') return 'snippetCreate';
    if (toolName === 'snippets_update') return 'snippetUpdate';
    return 'snippet';
  }

  if (artifact.kind === 'vault.snippet.deleted') return 'snippetDeleted';
  if (artifact.kind === 'vault.snippet.run') return 'snippetRun';

  if (artifact.kind === 'vault.script') {
    if (toolName === 'scripts_create') return 'scriptCreate';
    if (toolName === 'scripts_update' || toolName === 'scripts_targets_set') return 'scriptUpdate';
    return 'script';
  }

  if (artifact.kind === 'vault.script.deleted') return 'scriptDeleted';
  if (artifact.kind === 'vault.script.run') return 'scriptRun';
  if (artifact.kind === 'vault.script.runs') return 'scriptRuns';
  if (artifact.kind === 'vault.script.action') return 'scriptAction';
  if (artifact.kind === 'vault.script.reference') return 'scriptReference';

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
    case 'snippet':
    case 'snippetCreate':
    case 'snippetUpdate':
    case 'snippetRun':
      return <Zap size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'snippetList':
      return <SquareTerminal size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'snippetDeleted':
      return <Trash2 size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'script':
    case 'scriptCreate':
    case 'scriptUpdate':
    case 'scriptReference':
      return <FileCode size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'scriptList':
    case 'scriptRuns':
      return <ListChecks size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'scriptRun':
      return <Play size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'scriptDeleted':
      return <Trash2 size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'scriptAction':
      return <Pause size={ARTIFACT_ICON_SIZE} className={className} />;
    case 'error':
      return <AlertCircle size={ARTIFACT_ICON_SIZE} className={className} />;
    default:
      return <BookOpen size={ARTIFACT_ICON_SIZE} className={className} />;
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
