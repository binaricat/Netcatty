import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Host, Snippet } from '@/domain/models';
import {
  DEFAULT_SCRIPT_TEMPLATE,
  isScriptSnippet,
} from '@/domain/snippetScript.ts';
import {
  getRunnableHostsForSnippet,
} from '@/domain/snippetTargets.ts';
import {
  removeHostConnectScript,
  syncHostsForSnippetTargetChange,
} from '@/domain/hostConnectScripts.ts';
import { ScriptEditorModal } from '@/components/scripts/ScriptEditorModal';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/application/i18n/I18nProvider';

export interface QuickScriptEditorDialogProps {
  snippets: Snippet[];
  packages: string[];
  hosts: Host[];
  customGroups?: string[];
  onCreateSnippet: (snippet: Snippet) => void;
  onUpdateSnippet: (snippet: Snippet) => void;
  onCreatePackage?: (packagePath: string) => void;
  onUpdateHosts?: (hosts: Host[]) => void;
  onRunSnippet?: (snippet: Snippet, targetHosts: Host[]) => void;
}

function createBlankScript(): Partial<Snippet> {
  return {
    label: '',
    command: DEFAULT_SCRIPT_TEMPLATE,
    package: '',
    targets: [],
    kind: 'script',
    language: 'javascript',
    trigger: 'manual',
  };
}

export const QuickScriptEditorDialog: React.FC<QuickScriptEditorDialogProps> = ({
  snippets,
  packages,
  hosts,
  customGroups = [],
  onCreateSnippet,
  onUpdateSnippet,
  onCreatePackage,
  onUpdateHosts,
  onRunSnippet,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Partial<Snippet>>(createBlankScript);
  const [targetSelection, setTargetSelection] = useState<string[]>([]);

  useEffect(() => {
    const handler = () => {
      setEditingSnippet(createBlankScript());
      setTargetSelection([]);
      setOpen(true);
    };
    window.addEventListener('netcatty:scripts:add', handler);
    return () => window.removeEventListener('netcatty:scripts:add', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const snippet = (event as CustomEvent<{ snippet?: Snippet }>).detail?.snippet;
      if (!snippet || !isScriptSnippet(snippet)) return;
      setEditingSnippet(snippet);
      setTargetSelection(snippet.targetsAllHosts ? [] : (snippet.targets ?? []));
      setOpen(true);
    };
    window.addEventListener('netcatty:snippets:edit', handler);
    return () => window.removeEventListener('netcatty:snippets:edit', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        name: string;
        packagePath: string;
        code: string;
        editAfterSave: boolean;
      }>).detail;
      if (!detail?.code?.trim()) return;

      const packagePath = detail.packagePath?.trim() ?? '';
      if (packagePath && !packages.includes(packagePath)) {
        onCreatePackage?.(packagePath);
      }

      const snippet: Snippet = {
        id: crypto.randomUUID(),
        label: detail.name?.trim() || 'Recorded script',
        command: detail.code,
        package: packagePath,
        targets: [],
        kind: 'script',
        language: 'javascript',
        trigger: 'manual',
      };

      onCreateSnippet(snippet);
      toast.success(t('scripts.recording.savedNamed', { name: snippet.label }));
      window.dispatchEvent(new CustomEvent('netcatty:scripts:saved', {
        detail: { snippetId: snippet.id, packagePath },
      }));

      if (detail.editAfterSave) {
        setEditingSnippet(snippet);
        setTargetSelection([]);
        setOpen(true);
      }
    };
    window.addEventListener('netcatty:scripts:save-recorded', handler);
    return () => window.removeEventListener('netcatty:scripts:save-recorded', handler);
  }, [onCreatePackage, onCreateSnippet, packages, t]);

  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );

  const targetHosts = useMemo(
    () => targetSelection.map((id) => hostById.get(id)).filter(Boolean) as Host[],
    [hostById, targetSelection],
  );

  const runnableSnippet = useMemo(() => ({
    ...(editingSnippet as Snippet),
    targets: editingSnippet.targetsAllHosts ? [] : targetSelection,
    targetsAllHosts: editingSnippet.targetsAllHosts || undefined,
  }), [editingSnippet, targetSelection]);

  const runTargets = useMemo(
    () => getRunnableHostsForSnippet(runnableSnippet, hosts),
    [hosts, runnableSnippet],
  );

  const canRun = Boolean(editingSnippet.command?.trim()) && runTargets.length > 0;

  const syncHostsAfterSave = useCallback((savedSnippet: Snippet, nextSnippets: Snippet[]) => {
    if (!onUpdateHosts || !savedSnippet.id) return;
    const original = snippets.find((item) => item.id === savedSnippet.id);
    const prevTargetIds = original?.targetsAllHosts ? [] : (original?.targets ?? []);
    let nextHosts = hosts;

    if (isScriptSnippet(savedSnippet) && savedSnippet.trigger === 'onConnect') {
      nextHosts = syncHostsForSnippetTargetChange(hosts, savedSnippet, prevTargetIds, nextSnippets);
    } else if (original && isScriptSnippet(original) && original.trigger === 'onConnect') {
      nextHosts = hosts.map((item) => removeHostConnectScript(item, savedSnippet.id!, nextSnippets));
    }

    const changed = nextHosts.length !== hosts.length
      || nextHosts.some((host, index) => host !== hosts[index]);
    if (changed) {
      onUpdateHosts(nextHosts);
    }
  }, [hosts, onUpdateHosts, snippets]);

  const buildSavedSnippet = useCallback((): Snippet | null => {
    if (!editingSnippet.label?.trim() || !editingSnippet.command?.trim()) return null;
    const packagePath = editingSnippet.package?.trim() ?? '';
    if (packagePath && !packages.includes(packagePath)) {
      onCreatePackage?.(packagePath);
    }
    return {
      id: editingSnippet.id || crypto.randomUUID(),
      label: editingSnippet.label.trim(),
      command: editingSnippet.command,
      tags: editingSnippet.tags ?? [],
      package: packagePath,
      targets: editingSnippet.targetsAllHosts ? [] : targetSelection,
      targetsAllHosts: editingSnippet.targetsAllHosts || undefined,
      kind: 'script',
      language: editingSnippet.language ?? 'javascript',
      description: editingSnippet.description,
      trigger: editingSnippet.trigger ?? 'manual',
      triggerPattern: editingSnippet.triggerPattern,
      order: editingSnippet.order,
    };
  }, [editingSnippet, onCreatePackage, packages, targetSelection]);

  const persistSnippet = useCallback((): Snippet | null => {
    const savedSnippet = buildSavedSnippet();
    if (!savedSnippet) return null;
    const nextSnippets = snippets.some((item) => item.id === savedSnippet.id)
      ? snippets.map((item) => (item.id === savedSnippet.id ? savedSnippet : item))
      : [...snippets, savedSnippet];

    if (snippets.some((item) => item.id === savedSnippet.id)) {
      onUpdateSnippet(savedSnippet);
    } else {
      onCreateSnippet(savedSnippet);
    }
    syncHostsAfterSave(savedSnippet, nextSnippets);
    return savedSnippet;
  }, [buildSavedSnippet, onCreateSnippet, onUpdateSnippet, snippets, syncHostsAfterSave]);

  const handleSave = useCallback(() => {
    if (!persistSnippet()) return;
    setOpen(false);
  }, [persistSnippet]);

  const handleRun = useCallback(() => {
    const savedSnippet = persistSnippet();
    if (!savedSnippet) return;
    const targets = getRunnableHostsForSnippet(savedSnippet, hosts);
    if (targets.length === 0) {
      toast.error(t('scripts.actions.noRunnableHosts'));
      return;
    }
    if (onRunSnippet) {
      onRunSnippet(savedSnippet, targets);
    } else {
      window.dispatchEvent(new CustomEvent('netcatty:scripts:run-now', {
        detail: { snippet: savedSnippet },
      }));
    }
    setOpen(false);
  }, [hosts, onRunSnippet, persistSnippet, t]);

  const handleSelectHost = useCallback((host: Host) => {
    setTargetSelection((prev) => (
      prev.includes(host.id)
        ? prev.filter((id) => id !== host.id)
        : [...prev, host.id]
    ));
  }, []);

  const handleTargetsAllHostsChange = useCallback((checked: boolean) => {
    if (checked) {
      setTargetSelection([]);
      setEditingSnippet((prev) => ({
        ...prev,
        targetsAllHosts: true,
        targets: [],
      }));
      return;
    }
    setEditingSnippet((prev) => ({
      ...prev,
      targetsAllHosts: undefined,
    }));
  }, []);

  return (
    <ScriptEditorModal
      open={open}
      onClose={() => setOpen(false)}
      snippet={editingSnippet as Snippet}
      onChange={setEditingSnippet}
      onSave={handleSave}
      canRun={canRun}
      onRun={canRun ? handleRun : undefined}
      targetHosts={targetHosts}
      hosts={hosts}
      customGroups={customGroups}
      selectedHostIds={targetSelection}
      onSelectHost={handleSelectHost}
      targetsAllHosts={Boolean(editingSnippet.targetsAllHosts)}
      onTargetsAllHostsChange={handleTargetsAllHostsChange}
    />
  );
};
