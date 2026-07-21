import React, { useMemo, useState } from 'react';

import type { WorkSurfaceHostEditorTarget } from '../state/useWorkSurfaceHostEditor';
import { useI18n } from '../i18n/I18nProvider';
import HostDetailsPanel from '../../components/HostDetailsPanel';
import SerialHostDetailsPanel from '../../components/SerialHostDetailsPanel';
import { PortalContainerProvider } from '../../components/ui/portal-container';
import { resolveGroupDefaults } from '../../domain/groupConfig';
import { STORAGE_KEY_VAULT_HOST_PANEL_WIDTH } from '@/infrastructure/config/storageKeys';
import type {
  GroupConfig,
  Host,
  Identity,
  ManagedSource,
  ProxyProfile,
  Snippet,
  SSHKey,
} from '../../types';

export type WorkSurfaceHostEditorKind = 'standard' | 'serial';

export function resolveWorkSurfaceHostEditorKind(
  target: WorkSurfaceHostEditorTarget,
): WorkSurfaceHostEditorKind {
  return target.mode === 'edit' && target.openedHost.protocol === 'serial'
    ? 'serial'
    : 'standard';
}

function addGroupAndAncestors(groups: Set<string>, path: string | null | undefined) {
  const segments = path?.split('/').filter(Boolean) ?? [];
  for (let index = 1; index <= segments.length; index += 1) {
    groups.add(segments.slice(0, index).join('/'));
  }
}

export function collectWorkSurfaceHostGroups(
  hosts: Host[],
  customGroups: string[],
  groupConfigs: GroupConfig[],
): string[] {
  const groups = new Set<string>();
  for (const path of customGroups) addGroupAndAncestors(groups, path);
  for (const config of groupConfigs) addGroupAndAncestors(groups, config.path);
  for (const host of hosts) addGroupAndAncestors(groups, host.group);
  return Array.from(groups).sort((left, right) => left.localeCompare(right));
}

export function collectWorkSurfaceHostTags(hosts: Host[]): string[] {
  const tags = new Set<string>();
  for (const host of hosts) {
    for (const tag of host.tags ?? []) tags.add(tag);
  }
  return Array.from(tags).sort((left, right) => left.localeCompare(right));
}

export function getAppHostEditorLayerStyle(surfaceVisible: boolean): React.CSSProperties {
  return {
    display: surfaceVisible ? undefined : 'none',
    pointerEvents: surfaceVisible ? undefined : 'none',
  };
}

interface AppHostEditorLayerProps {
  surfaceVisible: boolean;
  target: WorkSurfaceHostEditorTarget | null;
  editorKey: string | null;
  hosts: Host[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  keys: SSHKey[];
  identities: Identity[];
  proxyProfiles: ProxyProfile[];
  managedSources: ManagedSource[];
  snippets: Snippet[];
  terminalThemeId: string;
  terminalFontSize: number;
  onSave: (host: Host) => void;
  onCancel: () => void;
  onCreateGroup: (groupPath: string) => void;
  onImportOrReuseKey: (draft: Partial<SSHKey>) => SSHKey;
  onUpdateSnippets: (snippets: Snippet[]) => void;
}

export const AppHostEditorLayer: React.FC<AppHostEditorLayerProps> = ({
  surfaceVisible,
  target,
  editorKey,
  hosts,
  customGroups,
  groupConfigs,
  keys,
  identities,
  proxyProfiles,
  managedSources,
  snippets,
  terminalThemeId,
  terminalFontSize,
  onSave,
  onCancel,
  onCreateGroup,
  onImportOrReuseKey,
  onUpdateSnippets,
}) => {
  const { t } = useI18n();
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const groups = useMemo(
    () => collectWorkSurfaceHostGroups(hosts, customGroups, groupConfigs),
    [customGroups, groupConfigs, hosts],
  );
  const allTags = useMemo(() => collectWorkSurfaceHostTags(hosts), [hosts]);
  const groupPath = target?.mode === 'edit'
    ? target.openedHost.group
    : target?.defaultGroup;
  const groupDefaults = useMemo(
    () => (groupPath ? resolveGroupDefaults(groupPath, groupConfigs) : undefined),
    [groupConfigs, groupPath],
  );
  // Share width persistence with Vault host details so both entry points feel consistent.
  const hostPanelResizeProps = {
    resizable: true as const,
    persistWidthStorageKey: STORAGE_KEY_VAULT_HOST_PANEL_WIDTH,
    resizeAriaLabel: t('vault.panel.resizeWidth'),
  };

  if (!target || !editorKey) return null;

  return (
    <div
      ref={setPortalContainer}
      className="pointer-events-none absolute inset-0 z-40 [&>*]:pointer-events-auto"
      data-section="app-host-editor-layer"
      style={getAppHostEditorLayerStyle(surfaceVisible)}
    >
      <PortalContainerProvider container={portalContainer}>
        {target.mode === 'edit' && target.openedHost.protocol === 'serial' ? (
          <SerialHostDetailsPanel
            key={editorKey}
            initialData={target.openedHost}
            allTags={allTags}
            groups={groups}
            groupDefaults={groupDefaults}
            onSave={onSave}
            onCancel={onCancel}
            layout="overlay"
            className="pointer-events-auto"
            {...hostPanelResizeProps}
          />
        ) : (
          <HostDetailsPanel
            key={editorKey}
            initialData={target.mode === 'edit' ? target.openedHost : null}
            availableKeys={keys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            groups={groups}
            managedSources={managedSources}
            allTags={allTags}
            allHosts={hosts}
            defaultGroup={target.mode === 'new' ? target.defaultGroup : undefined}
            terminalThemeId={terminalThemeId}
            terminalFontSize={terminalFontSize}
            groupDefaults={groupDefaults}
            groupConfigs={groupConfigs}
            snippets={snippets}
            onSnippetsChange={onUpdateSnippets}
            onImportKey={onImportOrReuseKey}
            onSave={onSave}
            onCancel={onCancel}
            onCreateGroup={onCreateGroup}
            layout="overlay"
            className="pointer-events-auto"
            {...hostPanelResizeProps}
          />
        )}
      </PortalContainerProvider>
    </div>
  );
};
