/**
 * Local Shell Host Details Panel
 * A dedicated editor for local shell / CMD vault hosts (protocol 'local'),
 * distinct from the SSH HostDetailsPanel. Lets users save named local shells
 * into vault groups next to their SSH hosts (issue #3615).
 */
import { ChevronDown, ChevronUp, Save, Tag, TerminalSquare, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useDiscoveredShells } from '../lib/useDiscoveredShells';
import { detectLocalOs } from '../lib/localShell';
import type { Host } from '../domain/models';
import { createLocalShellHost } from '../domain/localShellHost';

import { Button } from './ui/button';
import { Combobox, ComboboxOption, MultiCombobox } from './ui/combobox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from './ui/aside-panel';
import { HostNotesEditor } from './host/HostNotesEditor';
import { cn } from '../lib/utils';

interface LocalShellHostDetailsPanelProps {
  /** Existing host when editing; null/undefined when creating a new entry. */
  initialData?: Host | null;
  defaultGroup?: string;
  allTags?: string[];
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
  allTags = [],
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
  const [tags, setTags] = useState<string[]>(initialData?.tags ?? []);
  // On creation, initialize from defaultGroup so the field reflects what a
  // plain save would persist; clearing it then intentionally saves at the
  // vault root. Edits keep the host's own group (possibly empty).
  const [group, setGroup] = useState(
    initialData ? initialData.group ?? '' : defaultGroup ?? '',
  );
  const [notes, setNotes] = useState(initialData?.notes ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const matchedShell = useMemo(
    () => discoveredShells.find((candidate) => candidate.id === shell),
    [discoveredShells, shell],
  );

  // A custom shell path/command may still carry metadata saved earlier (when
  // discovery has since changed). Preserve it as long as the shell is untouched.
  const shellMeta = matchedShell ?? (
    shell && shell === initialData?.localShell
      ? {
          args: initialData?.localShellArgs,
          name: initialData?.localShellName,
          icon: initialData?.localShellIcon,
        }
      : undefined
  );

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

  const tagOptions: ComboboxOption[] = useMemo(() => {
    const allUniqueTags = new Set([...allTags, ...tags]);
    return Array.from(allUniqueTags).map((tag) => ({
      value: tag,
      label: tag,
    }));
  }, [allTags, tags]);

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
      os: detectLocalOs(navigator.userAgent || navigator.platform),
      label,
      shell,
      shellArgs: shellMeta?.args,
      shellName: shellMeta?.name,
      shellIcon: shellMeta?.icon,
      startDir,
      // Save the controlled value directly: '' means the user explicitly
      // cleared the group, which persists at the vault root.
      group: group,
      tags,
      notes,
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

        {/* Tags */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Tag size={14} />
            {t('hostDetails.tags')}
          </Label>
          <MultiCombobox
            options={tagOptions}
            values={tags}
            onValuesChange={setTags}
            placeholder={t('hostDetails.addTag')}
            allowCreate
            createText={t('hostDetails.createTag')}
          />
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

        <HostNotesEditor
          panelKey={initialData?.id ?? 'local-shell-new'}
          value={notes}
          onChange={setNotes}
        />

        {/* Advanced options */}
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-between h-9 px-0 hover:bg-transparent"
            >
              <span className="text-sm font-medium text-muted-foreground">
                {t('common.advanced')}
              </span>
              {showAdvanced ? (
                <ChevronUp size={14} className="text-muted-foreground" />
              ) : (
                <ChevronDown size={14} className="text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
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
          </CollapsibleContent>
        </Collapsible>
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
