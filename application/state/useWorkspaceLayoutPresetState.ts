import { useCallback } from 'react';

import {
  collectSidePanelPanes,
  getFocusedSidePanelPane,
  type SidePanelLayout,
  type SidePanelTool,
} from '../../domain/sidePanelLayout';
import {
  shouldAutoOpenSftpForHost,
  type AutoOpenSftpHost,
  type AutoOpenSftpHostOptions,
} from '../../domain/terminalSidePanelAutoOpen';
import {
  createWorkspaceLayoutPreset,
  rekeySidePanelLayout,
  withoutUnavailableSidePanelTools,
} from '../../domain/workspaceLayoutPreset';
import {
  readWorkspaceLayoutPreset,
  writeWorkspaceLayoutPreset,
} from './workspaceLayoutPresetStore';

/** Protocols whose sessions can actually serve an SFTP pane. */
function canServeSftp(protocol: string): boolean {
  return protocol === 'local' || protocol === 'ssh' || protocol === 'mosh';
}

export type ResolvedWorkspaceLayoutPreset = {
  layout: SidePanelLayout;
  focusedTool: SidePanelTool;
  /** Connection protocol used for availability filtering (`session.protocol ?? 'ssh'`). */
  protocol: string;
};

export type ResolveWorkspaceLayoutPresetOptions = {
  host?: AutoOpenSftpHost | null;
  remoteSshVersion?: string;
  deviceClass?: AutoOpenSftpHostOptions['deviceClass'];
};

/**
 * Application boundary for the saved default workspace side panel layout.
 * Owns the preset persistence lifecycle (read, validate, write) so UI
 * components consume handlers instead of touching the store directly.
 */
export function useWorkspaceLayoutPresetState() {
  /**
   * Resolve the saved default preset into a fresh layout for a newly
   * connected session. Panes the session cannot serve (SFTP/Browser on non-file
   * protocols, and default SFTP auto-open on network devices) are pruned, and
   * ids are rekeyed so several workspaces can run the same preset in parallel.
   * Returns null when there is no preset or nothing survives availability filtering.
   */
  const resolveDefaultLayoutForSession = useCallback(
    (
      session: { protocol?: string | null; autoOpenSidePanel?: 'sftp' },
      options?: ResolveWorkspaceLayoutPresetOptions,
    ): ResolvedWorkspaceLayoutPreset | null => {
      const preset = readWorkspaceLayoutPreset();
      if (!preset) return null;

      const proto = session.protocol ?? 'ssh';
      const sftpTransportSupported = canServeSftp(proto);
      const allowSftp = sftpTransportSupported && (
        proto === 'local'
        || shouldAutoOpenSftpForHost(options?.host, {
          explicitAutoOpen: session.autoOpenSidePanel === 'sftp',
          remoteSshVersion: options?.remoteSshVersion,
          deviceClass: options?.deviceClass,
        })
      );
      const usable = withoutUnavailableSidePanelTools(
        preset.layout,
        (tool) => {
          if (tool === 'sftp') return allowSftp;
          if (tool === 'browser') return sftpTransportSupported;
          return true;
        },
      );
      if (!usable) return null;

      const layout = rekeySidePanelLayout(usable, () => crypto.randomUUID());
      return { layout, focusedTool: getFocusedSidePanelPane(layout).tool, protocol: proto };
    },
    [],
  );

  const hasDefaultLayoutSftpPane = useCallback((): boolean => {
    const preset = readWorkspaceLayoutPreset();
    if (!preset) return false;
    return collectSidePanelPanes(preset.layout.root).some((pane) => pane.tool === 'sftp');
  }, []);

  /** Validate and persist a live layout as the default. False when invalid or the write failed. */
  const saveWorkspaceLayoutAsDefault = useCallback((layout: SidePanelLayout): boolean => {
    const preset = createWorkspaceLayoutPreset(layout);
    if (!preset) return false;
    return writeWorkspaceLayoutPreset(preset);
  }, []);

  return {
    resolveDefaultLayoutForSession,
    hasDefaultLayoutSftpPane,
    saveWorkspaceLayoutAsDefault,
  };
}
