/**
 * Local Shell Host Details Panel
 * A dedicated editor for local shell / CMD vault hosts (protocol 'local'),
 * distinct from the SSH HostDetailsPanel. Lets users save named local shells
 * into vault groups next to their SSH hosts (issue #3615).
 */
import { Save, TerminalSquare, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useDiscoveredShells } from '../lib/useDiscoveredShells';
import { detectLocalOs } from '../lib/localShell';
import type { Host } from '../domain/models';
import { createLocalShellHost } from '../domain/localShellHost';

import { Button } from './ui/button';
import { Combobox, ComboboxOption } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from './ui/aside-panel';
import { cn } from '../lib/utils';

interface LocalShellHostDetailsPanelProps {
  /** Existing host when editing; null/undefined when creating a new entry. */
  initialData?: Host | null;
  defaultGroup?: string;
  groups?: string[];
  onSave: (host: Host) => void;
  /** Saves the host and immediately opens a terminal for it. */
  onSaveAndConnect?: (host: Host) => void;
  onCancel: () => void;
  layout?: AsidePanelLayout;
  className?: string;
}

type LocalShellHostDetailsPanelPropsWithResize =
  LocalShellHostDetailsPanelProps & AsidePanelResizeProps;

export const LocalShellHostDetailsPanel: React.FC<LocalShellHostDetailsPanelPropsWithResize> = ({
  initialData,
  defaultGroup,
  groups = [],
  onSave,
  onSaveAndConnect,
  onCancel,
  layout = 'overlay',
  className,
  resizable,
  persistWidthStorageKey,
  resizeAriaLabel,
}) => {
  const { t } = useI18n();
  const discoveredShells = useDiscoveredShells();

  const [label, setLabel] = useState(initialData?.label ?? '');
  const [shell, setShell] = useState(initialData?.localShell ?? '');
  const [startDir, setStartDir] = useState(initialData?.localStartDir ?? '');
  // On creation, initialize from defaultGroup so the field reflects what a
  // plain save would persist; clearing it then intentionally saves at the
  // vault root. Edits keep the host's own group (possibly empty).
  const [group, setGroup] = useState(
    initialData ? initialData.group ?? '' : defaultGroup ?? '',
  );

  const matchedShell = useMemo(
    () => discoveredShells.find((candidate) => candidate.id === shell),
    [discoveredShells, shell],
  );

  // While the shell selection is unchanged from the saved host, prefer the
  // host's stored metadata: an imported/synced host may carry custom startup
  // arguments for a shell id that also exists in discovery, and saving an
  // unrelated edit (label, tag, group) must not overwrite them with the
  // current discovery result. Discovered metadata applies only after the user
  // changes the selection — or per-field when the host stores none.
  const shellMeta =
    shell && shell === initialData?.localShell
      ? {
          args: initialData?.localShellArgs ?? matchedShell?.args,
          name: initialData?.localShellName ?? matchedShell?.name,
          icon: initialData?.localShellIcon ?? matchedShell?.icon,
        }
      : matchedShell;

  const shellOptions: ComboboxOption[] = useMemo(() => {
    const options: ComboboxOption[] = [
      { value: '', label: t('localShell.field.shellDefault') },
    ];
    for (const candidate of discoveredShells) {
      options.push({
        value: candidate.id,
        label: candidate.name,
        sublabel: candidate.command,
      });
    }
    return options;
  }, [discoveredShells, t]);

  const groupOptions: ComboboxOption[] = useMemo(() => {
    const allGroups = new Set(groups);
    if (group && !allGroups.has(group)) {
      allGroups.add(group);
    }
    return Array.from(allGroups).map((g) => ({
      value: g,
      label: g,
    }));
  }, [groups, group]);

  const buildHost = (): Host => {
    const host = createLocalShellHost({
      id: initialData?.id,
      // Keep the entry's saved OS on edits: importing/syncing on one platform
      // then editing elsewhere must not silently re-classify the host (shell
      // defaults, CSV round trips, dedup) as the editor machine's OS.
      os: initialData?.os ?? detectLocalOs(navigator.userAgent || navigator.platform),
      label,
      shell,
      shellArgs: shellMeta?.args,
      shellName: shellMeta?.name,
      shellIcon: shellMeta?.icon,
      startDir,
      // Save the controlled value directly: '' means the user explicitly
      // cleared the group, which persists at the vault root.
      group: group,
      tags: initialData?.tags,
      notes: initialData?.notes,
    });
    // On edits, merge over the existing host so fields this form does not
    // expose (pinned, lastConnectedAt, order, ...) and the original
    // creation timestamp survive a save.
    return initialData
      ? { ...initialData, ...host, createdAt: initialData.createdAt ?? host.createdAt }
      : host;
  };

  const handleSave = () => onSave(buildHost());
  const handleSaveAndConnect = () => {
    if (!onSaveAndConnect) return;
    onSaveAndConnect(buildHost());
  };

  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      title={initialData ? t('localShell.panel.title.edit') : t('localShell.panel.title')}
      subtitle={initialData?.label}
      className={cn('z-40', className)}
      layout={layout}
      dataSection="local-shell-host-details-panel"
      resizable={resizable}
      persistWidthStorageKey={persistWidthStorageKey}
      resizeAriaLabel={resizeAriaLabel}
    >
      <AsidePanelContent>
        {/* Label */}
        <div className="space-y-2">
          <Label htmlFor="local-shell-label">{t('localShell.field.label')}</Label>
          <Input
            id="local-shell-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('localShell.field.labelPlaceholder')}
          />
        </div>

        {/* Shell */}
        <div className="space-y-2">
          <Label>{t('localShell.field.shell')}</Label>
          <Combobox
            options={shellOptions}
            value={shell}
            onValueChange={setShell}
            placeholder={t('localShell.field.shellDefault')}
            emptyText={t('localShell.field.shellEmpty')}
            allowCreate
            createText={t('common.use')}
            icon={<TerminalSquare size={14} className="text-muted-foreground" />}
          />
          <p className="text-xs text-muted-foreground">
            {matchedShell
              ? t('localShell.field.shellResolved', { command: matchedShell.command })
              : t('localShell.field.shellDefaultDesc')}
          </p>
        </div>

        {/* Group */}
        <div className="space-y-2">
          <Label>{t('hostDetails.group')}</Label>
          <Combobox
            options={groupOptions}
            value={group}
            onValueChange={setGroup}
            placeholder={t('hostDetails.selectGroup')}
            allowCreate
            createText={t('hostDetails.createGroup')}
          />
        </div>

        {/* Start directory */}
        <div className="space-y-2">
          <Label htmlFor="local-shell-start-dir">{t('localShell.field.startDir')}</Label>
          <div className="relative">
            <Input
              id="local-shell-start-dir"
              value={startDir}
              onChange={(e) => setStartDir(e.target.value)}
              placeholder={t('localShell.field.startDirPlaceholder')}
              className="pr-8"
            />
            {startDir && (
              <button
                type="button"
                onClick={() => setStartDir('')}
                aria-label={t('common.reset')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </AsidePanelContent>

      <AsidePanelFooter>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">
            {t('common.cancel')}
          </Button>
          {onSaveAndConnect && !initialData && (
            <Button
              onClick={handleSaveAndConnect}
              className="flex-1"
            >
              <TerminalSquare size={14} className="mr-2" />
              {t('localShell.saveAndConnect')}
            </Button>
          )}
          <Button onClick={handleSave} className="flex-1">
            <Save size={14} className="mr-2" />
            {t('common.save')}
          </Button>
        </div>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default LocalShellHostDetailsPanel;
